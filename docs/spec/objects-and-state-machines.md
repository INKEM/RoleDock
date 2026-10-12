# 规范：核心对象与状态机

协议版本：0.1
状态：P0 已固化（待独立验收）
对应 Schema：`packages/protocol/schemas/`

本文是 RoleDock 核心对象、状态机、可见性、知识版本与幂等规则的权威定义。JSON Schema 定义数据形态；本文定义状态语义与不变量。两者冲突时，以规范评审结论为准并同步修订。

## 1. 核心对象

| 对象 | Schema | 关键不变量 |
| --- | --- | --- |
| Workspace | （P1 落库） | 工作空间身份、配置与权限策略的根 |
| RoleDefinition | `rolepack.schema.json` | 来自角色包声明；核心不含任何角色枚举 |
| RoleHead | `role-head.schema.json` | `(workspace_id, role_id)` 唯一；请求分支永不替换主指针 |
| AgentInstance | （P3 落库） | 任职身份；旧代次实例失去正式发布权 |
| Session | （P3 落库） | 宿主会话映射；携带受信角色身份绑定 |
| DocumentRevision | `document-revision.schema.json` | 不可变；按 `(workspace_id, role_id, document_key)` 单调递增 |
| Checkpoint | `checkpoint.schema.json` | 不可变；记录准备时的 generation 与 knowledge_revision |
| BootstrapBundle | `bootstrap-bundle.schema.json` | 不可变；只含可分享角色知识 |
| CollaborationRequest | `collaboration-request.schema.json` | 绑定在接收事务内固定，之后不迁移 |
| ArtifactRef / CandidateUpdate | （P2/P4 落库） | 结果与候选更新的内容哈希及归并基线 |

标识符统一形态 `^[a-z][a-z0-9-]{0,63}$`；内容哈希为小写 SHA-256 十六进制；时间为 ISO 8601 UTC。角色 ID 是包内定义的任意标识，安装后在工作空间内唯一；安装冲突必须显式改名或拒绝（`ROLE_ALREADY_EXISTS`），不得静默覆盖。

## 2. 交接（Handoff）状态机

交接让一个角色的最新知识在新的宿主会话中延续。流程为：

```text
prepare → provision → activate → retire
```

1. **prepare**：读取旧代次 RoleHead（generation、knowledge_revision），生成 Checkpoint 与不可变 BootstrapBundle。准备期如果角色 `knowledge_revision` 发生变化，必须**重新准备**，不得把最新文档与旧交接摘要混成无来源的状态。
2. **provision**：通过 HarnessAdapter 创建新的宿主会话，载入 BootstrapBundle 并确认。准备或创建失败时保持旧主指针不变，已产生的 bundle 标记废弃。
3. **activate**：在单个事务内做**比较并交换**：校验当前 RoleHead 的 generation 与 knowledge_revision 仍等于 bundle 的 `source_generation` / `source_knowledge_revision`，然后写入新主指针（generation + 1）。并发激活**恰好一个成功**，失败者得到 `GENERATION_CONFLICT`。
4. **retire**：旧实例失去正式发布权。旧代次实例的发布请求一律 `INVALID_STATE_TRANSITION` 拒绝。

补充规则：

- 角色首次打开时自动初始化第 1 代主实例；协作请求发现目标角色没有主实例时返回 `ROLE_UNINITIALIZED`，初始化只由显式打开角色完成。
- **恢复已有会话不等于继承**：`sessions.resume` 不增加代次、不替换主指针、不触发交接校验。
- 交接摘要的完备性通过 Checkpoint 的引用、更新时间与待办登记帮助用户判断；框架不保证模型总结无遗漏，也不承诺"交接后不丢任何上下文"。

## 3. 请求（CollaborationRequest）状态机

```text
accepted → queued → running → awaiting_input ─┐
     │            │          │                 ├→ completed
     │            │          └─── failed ───────┤
     ├→ cancelled ┼──────────────────────────── ┤
     └→ expired ──┴──────────────────────────── ┴→ （终态，不可逆）
```

- 状态集：`accepted, queued, running, awaiting_input, completed, failed, cancelled, expired`。后四个为**终态**：终态不能再次转为运行或发布结果，任何此类转换返回 `INVALID_STATE_TRANSITION`。
- **接收时绑定**：在接收事务内固定目标代次与知识快照（写入 `binding`）。排队中与运行中的请求**不自动迁移**到新代次；代次切换后，新请求绑定新代次，旧请求保留旧快照。
- **创建不确定**：provision 阶段宿主会话创建结果不明时（如协调器重启），请求标记 `execution_uncertain = true`，不直接重试有副作用的执行；恢复流程先按创建键查询宿主，确认后再继续或失败。
- **幂等**：相同幂等键 + 相同内容 → 返回原请求；相同幂等键 + 不同内容 → `IDEMPOTENCY_CONFLICT`。
- **取消**：仅 `accepted/queued/awaiting_input` 可取消；对 `running` 的取消是对适配器的协商请求（P5 起语义），宿主不支持时请求继续到终态；已终态请求返回 `REQUEST_NOT_TERMINABLE`。
- **到期**：超过 `budget.deadline` 未完成的请求转 `expired`。
- **嵌套**：原型禁止请求执行中再自动发起请求；未来若开放，必须共享总预算并做调用链检测。

请求前置材料：发起会话须提供真实文档读取记录（`read_receipts`）；未读文档或文档不可读时填写可验证的 `read_exception_rationale`。

## 4. 知识版本

- `RoleHead.knowledge_revision` 是角色级知识版本，从 0 起。
- 每次正式发布（文档修订或交接摘要进入 Checkpoint）在同一事务内递增 knowledge_revision。发布校验 `expected_revision` 不匹配时返回 `REVISION_CONFLICT`，防止交接准备期间漏掉新知识。
- DocumentRevision、Checkpoint、BootstrapBundle 均不可变；"更新"永远是产生新的不可变记录。
- 数据库状态是实时权威来源；Markdown 导出是带版本的材料，外部编辑通过候选导入归并，不直接回写。

## 5. 可见性

| 级别 | 读取范围 |
| --- | --- |
| `project` | 工作空间内所有角色可读 |
| `role` | 仅所有者角色（含其请求分支会话）可读 |
| `private` | 仅所有者实例可读 |

可见性在读取入口统一强制：跨角色冒饮读取、越界可见性读取返回 `PERMISSION_DENIED`。角色包中的 `visibility` 是声明的默认级别，工作空间策略可以收紧，不能放松后不记录。

## 6. 幂等规则总表

| 操作 | 幂等键 | 同键同内容 | 同键异内容 |
| --- | --- | --- | --- |
| `roles.install` | 包名+版本+内容哈希 | 返回已安装结果（幂等成功） | `IDEMPOTENCY_CONFLICT` 或按哈希视为新版本，显式升级 |
| `sessions.open` | 创建键（creation key） | 返回原会话 | `IDEMPOTENCY_CONFLICT` |
| `documents.publish` | 无键；用 `expected_revision` CAS | 不适用 | `REVISION_CONFLICT` |
| `requests.create` | `idempotency_key` | 返回原请求 | `IDEMPOTENCY_CONFLICT` |
| `handoffs.activate` | bundle_id | 已激活则幂等返回 | `GENERATION_CONFLICT` |

宿主创建、执行等外部动作不在数据库事务内完成，统一走**待投递记录**（outbox）：事务内记录意图与创建键，外部动作完成后回填结果，重启后依据创建键对账（见 `identity-and-permissions.md` §5）。
