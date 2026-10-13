# P3 独立验收报告：会话继承与唯一最新继承者

- 阶段：P3（会话继承）
- 日期：2026-10-13
- 验收 Agent：ZCode（GLM，独立验收）
- 验收依据：`prompts/REVIEW.md`、`prompts/03-session-handoff.md`、`prompts/COMMON.md`、`docs/DEVELOPMENT_PLAN.md`、`AGENTS.md`、`docs/phase-reports/P2-review.md`
- 被验收报告：`docs/phase-reports/P3-development.md`

## 结论：**PASS**

P3 全部六项验收条件均满足且有真实、可复现的证据；交接状态机、恢复流程、能力协商与 Mock 语义实现正确；未发现需要返工的问题。真实宿主验证按计划留待 P5，开发报告已如实声明。

## 1. 验收基线

| 项 | 值 |
| --- | --- |
| HEAD | `1b8625c`（docs(p3): P3 development report） |
| 提交序列 | P2 验收基线 `b58fc04` + `92dec7f`（P3 实现）+ `1b8625c`（报告），与开发报告 §1 一致 |
| 工作树 | 干净 |
| 范围核查 | P3 提交对 `P2-review.md` 的改动即验收 Agent 报告原样入库（结论 PASS 未动） |

## 2. 独立执行的验证与结果

| 验证 | 结果 |
| --- | --- |
| `npm ci` → 立即 `npm run check`（CI 等价序列） | **全绿：21 个测试文件、237 个测试全部通过，0 跳过** |
| `npm run check` 第 2、3 轮 | 全绿 ×2（237/237），与开发报告一致 |
| 业务角色名独立 grep（packages + adapters/mock 的 src 与 schemas） | 零命中 |
| 跳过/聚焦测试扫描 | 零命中 |
| 未实现操作诚实性 | 剩余 5 个操作（requests ×4、artifacts.read）保持 `NOT_IMPLEMENTED`（测试动态枚举断言操作面恒 18） |
| 适配器注入模式 | 核心从不自行构造适配器（grep 零命中）；缺失时结构化报错指引 `Coordinator.open({ adapter })` |
| CLI 端到端手工验证（全新临时工作空间） | 见 §3 |

## 3. 验收条件逐项核验（含手工复现）

### 条件 1：首次创建和第二次创建具有正确代次、前任和知识引用 — ✅

CLI 实测：首次 `sessions open builder` → generation 1、`handoff.performed:false`、无前任；发布知识（revision 1 / knowledge_revision 1）后二次 `sessions open builder latest` → generation 2、`predecessor_instance_id` 指向 gen1 实例、返回 bundle_id 与 checkpoint_id。测试进一步断言：bundle 的 `source_generation=1`、`source_knowledge_revision=1`、state=activated；实例表恰两行（gen1 superseded → gen2 active，predecessor 正确）；主指针唯一。

### 条件 2：并发激活仅一个成功，失败者拿到冲突码，旧实例无法再发布 — ✅

双 prepare + 双 provision 后 B 先激活胜出，A 激活得到 `GENERATION_CONFLICT`；generation 2 实例恰一个；旧会话发布 → `INVALID_STATE_TRANSITION`（CLI 手工复现一致）。**术语说明**：P3 提示词称 HEAD_CONFLICT，P0 已固化的协议错误码注册表定名 `GENERATION_CONFLICT`；映射关系已写入 `adapter-contract.md` §6 与 `objects-and-state-machines.md` §2a，两份规范与实现统一。该语义要求（失败者拿到结构化冲突且失去发布权）完全满足，验收接受此映射而非要求别名码——P0 注册表是代码侧权威，添加别名反而破坏注册表/Schema/规范一致性。

### 条件 3：准备期间知识变化触发重新准备；宿主失败保留旧主指针 — ✅

- 知识漂移：手动 prepare 后发布 v2，编排路径自动重新准备——新 bundle 的 `source_knowledge_revision=2` 并成功激活，陈旧 bundle 保持 prepared 未被错误激活；重准备上限 3 次，旧 provisioned 宿主经 `abandonProvisioned` 废弃关闭（宿主 closeSession + 会话行/包状态落库）。
- 宿主失败：`failCreate` 注入 → `INTERNAL{stage:"provision"}`，主指针不动（generation 1、原实例仍是 current），bundle → abandoned。激活期 `GENERATION_CONFLICT`（指针被并发移动）**不**触发重准备——失败者不会覆盖胜者，语义正确。

### 条件 4：consultation 类型会话不成为主实例；resume 不增加 generation — ✅

- request-kind 会话调用 prepare → `INVALID_STATE_TRANSITION`（只有当前主实例的主会话可准备交接），其会话行经断言永不获得实例绑定。
- resume 三态均有测试且 CLI 手工复现：原生能力 + 宿主在持有 → `resumed:true, method:"native"`；无能力 → `resumed:false` + 指向语义继承；**跨进程宿主不持有**（本机实测：恢复上一进程创建的交接后继会话）→ `resumed:false` + alternative 指引，generation 保持 2 不变。三种路径 generation 均不动、主指针不被触碰。

### 条件 5：创建状态不明时不盲目重复生成会话，恢复说明与测试符合能力声明 — ✅

- 无 lookup 能力：创建不确定 → 结构化 `ADAPTER_CAPABILITY_MISSING` + `details.execution_uncertain:true`，恰 1 条 uncertain 会话行；同 creation_key 重试仍 1 条（不新建）。
- 有 lookup 能力（`uncertainCreateTimes:1` 注入首次不确定）：按创建键对账续接，交接完成且该键下恰 1 个宿主会话；同键再开幂等返回原会话。
- 崩溃恢复基础：会话行/bootstrap_bundles 行**先于宿主调用**落库（代码顺序核实），重启后同 creation_key 打开即触发对账——符合规范 §2a 恢复表。

### 条件 6：Mock 测试覆盖上述条件，报告明确仍缺真实宿主验证 — ✅

Mock 套件 8 用例（能力声明/受限等级/bootstrap 哈希宿主侧校验/不确定创建/硬失败/跨角色 fork 拒绝/fork 计数观察口）+ 交接矩阵 12 用例全绿；开发报告 §5 明确"真实宿主验证仍缺，属 P5，在此之前不声称真实接入"——与蓝图"Mock 只证明核心状态机制"的定位一致。

## 4. 专项与约束检查

- **旧会话不被污染**：交接全程核心不调用旧会话 runTurn；测试断言前任宿主 transcript 逐字不变、旧会话行不被改写，后继宿主只载入 bootstrap（transcript 为空）。
- **nativeFork 政策**：核心继承路径从不调用 nativeFork（Mock `nativeForkInvocationCount` 断言为 0）；Mock 拒绝跨角色全量私人历史 fork，可分享 bundle 分支不携带 transcript——符合 ADR-0002。
- **契约冻结**：prepare 把角色注册的包契约（名称/版本/内容哈希）冻结进 bundle，后继载入同一契约；P1 安装器拒绝角色 ID 静默覆盖，显式升级流程未实现且如实声明——旧会话不可能被静默换约。
- **迁移 003**：`agent_instances` 因 superseded 状态按 SQLite 惯例重建回填；`bootstrap_bundles` 表落库；既有校验和/未知迁移防护继续生效。
- **P0 硬约束延续**：核心与 Mock 无业务角色（grep + conformance）；声明≠授权未回退（交接激活仍走绑定+主实例校验，prepare 拒绝非主实例会话）；CLI 注入 Mock 适配器且不铸造会话身份之外的权利；无跳过测试；`HANDOFF` 语义与 P0 规范 §2 一致（resume≠继承、首次打开自动初始化、ROLE_UNINITIALIZED 语义保留）。
- **P2 夹具边界延续**：`@roledock/core/testing` 仍仅为测试入口；P3 的 `sessions.open` 成为生产初始化/交接路径，gen-1 初始化语义与夹具一致。

## 5. 问题清单

无返工项。非阻塞观察项：

| 编号 | 优先级 | 说明 |
| --- | --- | --- |
| O-1 | P3 | no-business-roles 扫描名单范围（历阶段延续）。 |
| O-2 | P3 | 远程 CI 与托管位置待用户决策（P0 起延续）；本阶段 CI 等价序列首轮即全绿。 |
| O-4 | P3 | `sessions.resume` 对**无宿主引用**的会话（gen-1 核心自管会话）返回 `method:"native"` 的 `resumed:true`——当前无宿主存在，该语义为"会话仍活跃"而非真实宿主恢复，现有测试固化了此行为且无误导性后果；P5 接入真实宿主时建议区分"会话活跃"与"宿主原生恢复已发生"两种结果，避免信封语义歧义。真实宿主未持有时的诚实降级（`resumed:false`）已有测试与本机实测覆盖。 |

## 6. 下一步

1. **P3 通过**，按流程可进入 P4（协作请求）。P4 可直接使用：sessions 表 kind='request' 与可见性限制、受信身份解析、回执表、候选区、适配器端口与 `execution_uncertain` 语义——开发报告 §6 交接清单与实际代码相符。
2. 真实宿主验证缺口已由开发报告与本报告共同记录，P5 完成前不声称"真实接入"。
3. 本验收流程不授予代码合并或远程发布权限。
