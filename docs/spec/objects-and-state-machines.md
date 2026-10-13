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
- **恢复已有会话不等于继承**：`sessions.resume` 只在适配器声明 `nativeResume` 时执行原生恢复；适配器实例不持有该宿主会话时如实返回 `resumed:false` 并指向语义继承（`sessions.open inherit=latest`）。resume 永不加代次、不动主指针。
- **原生 fork 不是必需能力**（ADR-0002）：核心的继承路径永远是"新建宿主会话 + BootstrapBundle"；跨角色携带全量私人历史的原生分支被拒绝。
- 交接摘要的完备性通过 Checkpoint 的引用、更新时间与待办登记帮助用户判断；框架不保证模型总结无遗漏，也不承诺"交接后不丢任何上下文"。

### 2a. 交接恢复流程（P3）

| 故障 | 行为 |
| --- | --- |
| 准备期间知识变化 | activate CAS 检出 `REVISION_CONFLICT`；编排路径自动**重新准备**（新 checkpoint、新宿主会话，旧 provisioned 宿主废弃关闭），上限 3 次后如实失败 |
| 两个继承者并发激活 | 单事务比较并交换，恰好一个成功；失败者 `GENERATION_CONFLICT`（即 P3 提示词所称 HEAD_CONFLICT），不得对其重新准备 |
| 适配器创建失败（宿主侧无效果） | 旧主指针保持不动，bundle → abandoned，会话行 → failed，错误带 `stage:"provision"` 上抛 |
| 创建状态不明（宿主可能已创建） | 会话行标记 `uncertain`；适配器声明 `lookupSessionByCreationKey` 时按创建键对账续接；未声明时返回带 `execution_uncertain` 的结构化错误。**同 creation_key 重试按创建键对账恢复，不盲目新建宿主会话** |
| 协调器中途退出 | sessions/bootstrap_bundles 行已先于宿主调用落库；重启后用同一 creation_key 打开即触发上述对账恢复 |

旧实例交接后置 **superseded**：其正式发布即刻被核心拒绝（`INVALID_STATE_TRANSITION`）；原宿主会话的既有对话不被注入任何交接指令——核心在 prepare/provision/activate 中从不调用旧会话的 runTurn。角色包契约在 prepare 时冻结进 bundle，交接载入同一契约（无静默换约；显式升级流程为后续扩展）。

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
- **取消**：仅 `accepted/queued/awaiting_input` 可取消；`running` 的取消是对适配器的协商（适配器声明 `cancel` 能力时），宿主不支持时请求继续到终态；已终态请求返回 `REQUEST_NOT_TERMINABLE`。仅发起者可取消。
- **到期**：超过 `budget.deadline` 未完成的请求在读路径与执行前**惰性转 `expired`**；终态后迟到结果一律 `INVALID_STATE_TRANSITION` 拒收，不能完成请求或触发发布。
- **预算**：`max_turns`/`max_output_bytes`/`deadline` 是能力作用域的一部分——超限请求转 `failed`（错误码 `PERMISSION_DENIED`），不可绕过；模型 token 用量以宿主报告为准（Mock 不模拟）。
- **输入等待**：宿主报告 `needs_input` 时进入 `awaiting_input`；仅发起者可 `requests.reply`，回复使请求回到 `queued` 重新排队。
- **嵌套**：原型禁止请求执行中再自动发起请求——consultation 分支会话调用 `requests.create` 返回 `PERMISSION_DENIED`；未来若开放，必须共享总预算并做调用链检测。
- **资源回收**：请求进入终态即清理其临时目录；正式结果（artifact）与收件箱条目保留供读取与采纳。

请求前置材料：发起会话须提供真实文档读取记录（核心从回执表取，输入不可伪造）；未读文档或文档不可读时填写可验证的 `read_exception_rationale`，两者皆无 → `VALIDATION_FAILED`。

**结果采纳（P4）**：完成的结果注册为 artifact 并投递到目标角色收件箱；由**当前所有者主实例**经 `documents.publish` 的 `adopt_artifact_id` 显式采纳——采纳时核心内联创建 `source='request.result'` 的候选并走标准 baseline/CAS 校验，纯数据库操作，绝不启动用户主会话新轮次。**旧分支无正式写权限**：请求绑定的 generation 或契约版本与当前 head 不一致时，采纳返回 `REVISION_CONFLICT`（结果仍可被读取）。

## 4. 知识版本

- `RoleHead.knowledge_revision` 是角色级知识版本，从 0 起。
- 每次正式发布（文档修订或交接摘要进入 Checkpoint）在同一事务内递增 knowledge_revision。发布校验 `expected_revision` 不匹配时返回 `REVISION_CONFLICT`，防止交接准备期间漏掉新知识。
- DocumentRevision、Checkpoint、BootstrapBundle 均不可变；"更新"永远是产生新的不可变记录。
- 数据库状态是实时权威来源；Markdown 导出是带版本的材料，外部编辑通过候选导入归并，不直接回写。

## 5. 可见性

P2 起为四级阶梯（private < role < project < public）：

| 级别 | 读取范围 |
| --- | --- |
| `private` | 仅创建该修订的实例（owning instance）可读 |
| `role` | 所有者角色的**主会话**可读 |
| `project` | 工作空间内任意活动会话可读 |
| `public` | 同 project，且为默认分享导出的范围（可跨工作空间消费） |

**咨询分支限制**：`kind='request'` 的会话（P4 请求分支）只读 project/public——同角色咨询分支不能凭相同 role_id 读取 role/private 材料。角色包中的 `visibility` 是声明的默认级别；越界读取返回 `PERMISSION_DENIED`。

## 5a. 读取回执与候选更新（P2）

- **读取回执**：`documents.read` 成功后由核心记录，绑定真实调用会话、实例、读者角色、确切修订与内容哈希及时间；回执只由读取路径产生，没有可指定任意会话的公开写入面；伪造（未知会话或绑定不符）失败。P4 请求前置验证消费回执。
- **候选更新**：提案与导入进入独立候选区（open 状态），携带 baseline_revision 与来源（`documents.propose` / `knowledge.import`）。采纳由所有者发布时进行并**再次校验 baseline 仍等于当前修订**，过期采纳返回 `REVISION_CONFLICT` 且候选内容保留；候选永不自动合并咨询分支历史。状态机：open → adopted / superseded / rejected（终态）。

## 5b. 知识导出与导入（P2）

- **导出**：`scope:"share"`（默认）只含 public/project 文档，不含 checkpoints、凭据、私人聊天与角色私有材料；`scope:"workspace"` 为所有者本地全量导出（含 checkpoints）。bundle 目录含 manifest.json（经 `knowledge-export` Schema 校验）+ 正文 markdown + 校验点 JSON；写出时重算内容哈希。
- **导入**：先全量重算每个文件的 SHA-256 与 manifest 比对，被篡改的 bundle 拒绝且数据库零改动；**导入一律落为候选更新**（baseline = 导出修订），不直接改写数据库（ADR-0004）；private/role 条目即使出现在手改包中也跳过并报告；目标工作空间未安装角色或未声明文档键的条目跳过并报告。

## 6. 幂等规则总表

| 操作 | 幂等键 | 同键同内容 | 同键异内容 |
| --- | --- | --- | --- |
| `roles.install` | 包名+版本+内容哈希 | 返回已安装结果（幂等成功） | `IDEMPOTENCY_CONFLICT` 或按哈希视为新版本，显式升级 |
| `sessions.open` | 创建键（creation key） | 返回原会话 | `IDEMPOTENCY_CONFLICT` |
| `documents.publish` | 无键；用 `expected_revision` CAS | 不适用 | `REVISION_CONFLICT` |
| `requests.create` | `idempotency_key` | 返回原请求 | `IDEMPOTENCY_CONFLICT` |
| `handoffs.activate` | bundle_id | 已激活则幂等返回 | `GENERATION_CONFLICT` |

宿主创建、执行等外部动作不在数据库事务内完成，统一走**待投递记录**（outbox）：事务内记录意图与创建键，外部动作完成后回填结果，重启后依据创建键对账（见 `identity-and-permissions.md` §5）。
