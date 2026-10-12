# P3 开发报告：会话继承与唯一最新继承者

- 阶段：P3（会话继承）
- 日期：2026-10-13
- 开发 Agent：ZCode（GLM）
- 前置：P2 已通过独立验收（`P2-review.md` 结论 PASS，基线 `b58fc04`）
- 状态：**待独立验收**

## 1. 实际基线

| 提交 | 内容 |
| --- | --- |
| `098f346`…`b58fc04` | P0+P1+P2 已验收基线 |
| `92dec7f` | P3 实现：适配器端口与 Mock 包、迁移 003、交接服务、sessions/handoffs 公开操作、CLI、测试 |
| （本报告所在提交） | spec/文档更新 + P3 开发报告 |

工作树在提交后干净；无用户未提交改动需要保留。

## 2. 任务完成度与验收条件对照

P3 提示词 8 项任务：

1. ✅ **HarnessAdapter 接口、能力结果与 Mock**：端口在 `packages/core/src/ports/adapter.ts`（必选 getCapabilities/createSession/runTurn/getResult/closeSession；可选 cancel/lookupSessionByCreationKey/nativeResume/nativeFork；`AdapterCapabilities` 含 level full/restricted 与四项隔离声明）；Mock 为独立工作区包 `@roledock/adapter-mock`（`adapters/mock/`，蓝图布局），可配置故障注入（创建硬失败 / 创建后不确定 / 前 N 次不确定）、能力开关与隔离等级，记录 transcript 与已载入 bundle，createSession 校验 bundle 内容哈希，nativeFork 拒绝跨角色全量私人历史。依赖方向 adapter→core，核心经 `Coordinator.open({adapter})` 注入，从不自行构造宿主。
2. ✅ **sessions.open**：未初始化角色自动初始化第 1 代（无交接）；已初始化角色必须 `inherit:"latest"` 执行完整交接（缺省 → `VALIDATION_FAILED` 指引）。
3. ✅ **prepare→provision→activate→retire**：prepare 调用 P2 CheckpointBuilder 固化 generation/knowledge_revision 与文档快照，冻结角色包契约三元组，落 `bootstrap_bundles`；provision 经注入适配器创建宿主并确认 BootstrapBundle 载入（Mock 侧哈希校验）；activate 单事务比较并交换（generation+knowledge_revision 双校验），新实例 generation+1、旧实例置 **superseded**、指针切换、会话绑定，全部同一事务。
4. ✅ **旧实例撤权与不污染**：superseded 实例的发布被 P2 既有主实例校验即刻拒绝（`INVALID_STATE_TRANSITION`，测试断言）；交接全程核心不调用旧会话的 runTurn——测试断言旧宿主 transcript 逐字不变、旧会话行不被改写，后继宿主只载入 bootstrap（transcript 为空）。
5. ✅ **恢复流程**（规范 §2a 表格化）：知识漂移 → activate 检出 `REVISION_CONFLICT` → 编排自动重新准备（上限 3 次，旧 provisioned 宿主废弃关闭）；并发激活 → `GENERATION_CONFLICT` 不重准备；适配器创建硬失败 → 旧指针不动、bundle abandoned；创建不确定 → 会话行 `uncertain` + 按创建键对账（有 lookup 能力续接，无能力返回带 `execution_uncertain` 的结构化错误）；协调器中途退出 → 行先于宿主调用落库，同 creation_key 重开即对账。
6. ✅ **resume 语义**：仅适配器声明 `nativeResume` 时执行；适配器实例不持有该宿主（如内存 Mock 跨进程）时如实返回 `resumed:false` 并指向语义继承；**resume 永不加代次、不动主指针**（两种路径均有测试）。
7. ✅ **原生 fork 政策**：核心继承路径从不调用 nativeFork（Mock 记录调用次数为 0 的断言）；Mock 的 nativeFork 拒绝跨角色全量私人历史，bundle-shareable 分支可用但不携带 transcript。
8. ✅ **契约冻结**：bundle 冻结角色注册时的 pack 契约（名称/版本/内容哈希），交接载入同一契约；P1 安装器本就拒绝角色 ID 静默覆盖，显式升级流程明确记录为未实现——旧会话不可能被静默换约。

P3 验收条件逐项：

| 验收条件 | 证据 |
| --- | --- |
| 首次创建和第二次创建具有正确代次、前任和知识引用 | handoff.test.ts：gen1 无交接/无前任；gen2 predecessor 指向 gen1 实例；bundle 的 source_generation=1、source_knowledge_revision=1（发布后）、checkpoint_id 非空、state=activated；实例表恰两行（superseded→active，predecessor 正确） |
| 并发激活仅一个成功，失败者拿到 HEAD_CONFLICT，旧实例无法再发布 | 双 prepare + 双 provision + B 先激活胜出；A 激活 → `GENERATION_CONFLICT`（即提示词所称 HEAD_CONFLICT，见 §5 术语映射）；旧会话发布 → `INVALID_STATE_TRANSITION`；generation=2 实例恰一个 |
| 准备期间知识变化触发重新准备；宿主失败保留旧主指针 | 手动 prepare 后发布 v2 → openSession 自动重准备（新 bundle kr=2、旧 bundle 保持 prepared、成功激活）；failCreate 注入 → `INTERNAL{stage:provision}`，head 不动、bundle abandoned |
| consultation 类型会话不成为主实例，resume 不增加 generation | request-kind 会话 prepare → `INVALID_STATE_TRANSITION`，其会话行永不获得实例绑定；resume（native 能力/无能力/跨进程不持有宿主三态）后 head.generation 均不变 |
| 创建状态不明时不盲目重复生成会话，恢复说明与测试符合能力声明 | 无 lookup：`ADAPTER_CAPABILITY_MISSING` + `execution_uncertain`、恰 1 条 uncertain 会话行、重试仍 1 条；有 lookup（前 1 次不确定）：恢复续接成功、创建键下恰 1 个宿主会话、同键再开幂等返回原会话 |
| Mock 测试覆盖上述条件，报告明确仍缺真实宿主验证 | Mock 套件 8 用例 + 交接矩阵 12 用例全绿；**真实宿主验证未做**，见 §5 |

## 3. 主要文件与公共接口变化

- **`@roledock/core`**：`ports/adapter.ts`（HarnessAdapter 端口与类型，index 导出）；Coordinator 新实现 `openSession`/`resumeSession`/`prepareHandoff`/`activateHandoff`（`IMPLEMENTED_OPERATIONS` 9 → **13**），`HandleOptions` 增加 `adapter` 注入；新模块 `sessions/handoff.ts`（三步 + `rehydratePreparation`）、`sessions/open.ts`（编排 + resume）；迁移 003（`bootstrap_bundles` 表、agent_instances 重建支持 superseded）。
- **`@roledock/adapter-mock`**（新包）：`MockHarnessAdapter` + `peek`/`nativeForkInvocationCount` 测试观察口。
- **`@roledock/cli`**：`sessions open <role> [inherit]`、`sessions resume <session_id>`、`handoffs prepare/activate` 接通（CLI 注入 Mock 适配器）；未实现操作 9 → **5**（requests×4、artifacts.read）。
- **规范更新**：`objects-and-state-machines.md` §2 补充 resume/fork 政策与 §2a 恢复流程表；`adapter-contract.md` §5 Mock 参考、§6 HEAD_CONFLICT↔GENERATION_CONFLICT 术语映射；`sdk-operations.md` sessions/handoffs 交付语义；AGENTS/README/adapters-README 状态。

## 4. 实际运行的验证与证据

2026-10-13 本机（Ubuntu 22.04.5, Node v22.23.2）实际执行：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（src+tests 全量，含 adapters） |
| `npm test` / `npm run check` | **21 个测试文件、237 个测试全部通过，0 跳过**；连续 3 轮 check 全绿 |
| P3 新增测试 | 26 个（Mock 套件 8、交接矩阵 12、CLI sessions 2、既有断言更新若干），覆盖全部验收路径 |
| CLI 端到端（测试内） | `sessions open` 初始化 gen1 → 发布知识 → 二次 open 走完整交接 gen2（predecessor 正确）→ resume 如实报告 |

开发过程中修复的问题：迁移 1 的 agent_instances CHECK 不含 superseded → 迁移 003 重建回填；`coordinatorOperations` 反射把两个私有助手方法计入操作面 → NON_OPERATIONS 过滤（操作面恒 18 个操作）；内存 Mock 跨进程不持有宿主 → resume 如实降级而非谎报成功；consultation 会话的授权检查顺序（先验会话种类再验绑定）。

## 5. 失败、跳过、未验证与外部阻塞项

- **真实宿主验证仍缺**（本阶段明确范围）：Mock 只证明核心状态机制。角色载入、上下文隔离与端到端闭环的真实 Harness 验证按计划属 P5；在此之前不声称"真实接入"。
- **无跳过的测试，无失败遗留**。
- **术语映射（规范矛盾说明）**：P3 提示词称交接 CAS 失败为 HEAD_CONFLICT；P0 已固化的协议错误码为 **`GENERATION_CONFLICT`**（注册表/Schema/规范一致）。实现与测试使用 GENERATION_CONFLICT，映射关系写入 `adapter-contract.md` §6 与本报告；如验收要求别名码，属一行级返工。
- **明确不声称**：requests×4 与 artifacts.read 共 5 个操作未实现（`NOT_IMPLEMENTED`）；显式角色包升级流程未实现（契约冻结、无静默换约）；原生 fork 不在核心路径；无真实宿主验证。
- 沿用待确定项：远程 CI 与托管位置（O-2）。

## 6. 下一阶段可用输入与尚未满足的退出条件

**P4 可直接使用**：sessions 表 kind='request'（可见性矩阵已限制其读取范围）、受信身份解析、回执表（P4 请求前置验证直接消费）、候选区与 `REQUEST_NOT_TERMINABLE` 等错误码、适配器端口（请求执行分支经 createSession 走通用路径）、`execution_uncertain` 语义（请求 Schema 已有同名字段）。

**P3 退出条件核对**：并发交接与失败恢复测试通过 ✅（§2 对照）。

按流程，下一步把 `prompts/REVIEW.md` 交独立验收 Agent 验收 P3（基线以 `git log` 为准，HEAD 为本报告提交）；验收通过前不执行 P4。
