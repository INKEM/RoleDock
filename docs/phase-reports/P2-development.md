# P2 开发报告：版本文档与可迁移知识

- 阶段：P2（文档与知识）
- 日期：2026-10-13
- 开发 Agent：ZCode（GLM）
- 前置：P1 已通过独立验收（`P1-review.md` 复验结论 PASS，R-1/R-2 关闭，基线 `b4ceeae`）
- 状态：**待独立验收**

## 1. 实际基线

| 提交 | 内容 |
| --- | --- |
| `098f346`…`b4ceeae` | P0+P1 已验收基线（含 P1 返工） |
| `f2b2dd4` | P2 实现：版本文档、CheckpointBuilder、知识导出导入、协议增量、CLI 接通、测试 |
| （本报告所在提交） | spec/AGENTS/README 更新 + P2 开发报告 |

工作树在提交后干净；无用户未提交改动需要保留。

## 2. 任务完成度与验收条件对照

P2 提示词 8 项任务：

1. ✅ **documents.list/read/propose/publish 与不可变历史**：修订正文存内容寻址区（`<root>/.roledock/objects/<hash[:2]>/<hash>`，读取时重算哈希校验）；发布校验**所有者（来自会话绑定，非输入）**、**当前主实例**（非当前实例 → `INVALID_STATE_TRANSITION`）、**expected_generation**（不符 → `GENERATION_CONFLICT`）、**expected_revision**（不符 → `REVISION_CONFLICT`，details 带当前修订）；document_key 必须在角色包声明中；每次发布同事务递增 `knowledge_revision`。
2. ✅ **内部测试夹具**：`@roledock/core/testing` 的 `testingOpenPrimarySession`——未初始化角色自动初始化第 1 代主实例（符合规范 §2），已初始化角色在夹具路径直接代次递增（仅供测试构建旧代次场景）。夹具经模块私有 WeakMap 注册表访问 store，**Coordinator 未新增任何公开成员**；测试断言 `coordinatorOperations()`、`IMPLEMENTED_OPERATIONS` 与 Coordinator 原型均无 testing 入口，CLI 命令表不含夹具；AGENTS.md 与规范注明 P3 的 sessions.open 为生产路径。
3. ✅ **四级可见性**：private（仅创建实例）/ role（所有者角色**主会话**）/ project（任意活动会话）/ public（同 project 且为默认分享导出范围）；**咨询分支限制**——`kind='request'` 会话只读 project/public，同角色分支不能读 role/private 材料（本期实现并由测试覆盖，P4 复用）。
4. ✅ **读取回执**：`documents.read` 成功即记录，绑定真实会话/实例/读者角色/确切修订/内容哈希/时间；回执只由读取路径产生（无任意会话写入面），伪造未知会话 → `VALIDATION_FAILED`；`listReceiptsForSession` 供 P4 请求前置验证。
5. ✅ **候选独立区域**：候选带 baseline_revision 与来源（propose/import），open/adopted/superseded/rejected 状态机；采纳在发布时**再次校验 baseline**，过期采纳 `REVISION_CONFLICT` 且候选内容保留；无自动合并。
6. ✅ **knowledge_revision 与 CheckpointBuilder**：发布同事务递增；`buildCheckpoint` 快照该角色**已持久化**文档的确切 revision+content_hash（未发布内容绝不进入快照），捕获 generation/knowledge_revision/实例，摘要带哈希与时间，决策引用/待办/来源登记；结果过 protocol `checkpoint` Schema 校验后落 checkpoints 表。
7. ✅ **导出与导入**：`knowledge.export` 产出 manifest.json（`knowledge-export` Schema 校验）+ 正文 markdown（写出时重算哈希）；`knowledge.import` 先全量重算每个文件 SHA-256（篡改 → `VALIDATION_FAILED`，数据库零改动），**一律落为候选**（ADR-0004），不悄悄改写数据库。
8. ✅ **导出过滤与跨适配器**：`scope:"share"`（默认）只含 public/project，不含 private/role 与 checkpoints；workspace 全量导出仅所有者本地；导入侧即使手改包夹带 private/role 条目也跳过并报告；round-trip 测试把 bundle 导入第二个工作空间（模拟另一适配器）生成候选且哈希一致。

P2 验收条件逐项：

| 验收条件 | 证据 |
| --- | --- |
| 文档历史可读；过期发布、非所有者发布和旧代次发布均失败 | documents.test.ts：历史修订可读且哈希不变；`REVISION_CONFLICT`/非所有者 `VALIDATION_FAILED`（所有者来自绑定）/旧代次 `INVALID_STATE_TRANSITION`（夹具构建第 2 代后旧会话发布被拒） |
| 并发发布保留一个成功版本，另一项冲突不丢失候选内容 | 同基线双发布一胜一 `REVISION_CONFLICT`（details.current_revision）；败者内容经 propose 保留为 open 候选（内容与 baseline 断言） |
| 每次相关知识发布均更新 knowledge_revision，快照引用确切文档版本 | 发布返回值与 role_heads 断言递增；checkpoint 快照逐文档断言确切 revision+hash；二次构建捕获新版本 |
| 读取回执不能跨身份冒用；候选导入必须校验导出基线 | 回执绑定真实 session/instance/读者角色（伪造会话失败、writer 会话无污染）；导入候选带导出修订为 baseline，过期采纳 `REVISION_CONFLICT` 且候选保留 |
| 导出／导入往返保持哈希与来源，私人材料不会进入默认分享包 | round-trip 测试（第二工作空间）：候选哈希 = 原文哈希、baseline = 导出修订；share 导出断言仅 project/public、无 checkpoints；手改包夹带 private 条目被跳过 |

## 3. 主要文件与公共接口变化

**`@roledock/protocol`**：`document-revision`/`rolepack` Schema 的 visibility 枚举扩展为 private/role/project/public；新增 `candidate-update.schema.json`、`knowledge-export.schema.json`；TS 类型新增 `CandidateUpdate`、`DocumentReadReceipt`、`KnowledgeExportManifest` 等；`SCHEMA_NAMES` 8 → 10。

**`@roledock/core`**：

- `Coordinator` 新实现 6 个操作（documents.list/read/propose/publish、knowledge.export/import），`IMPLEMENTED_OPERATIONS` 3 → **9**；其余 9 个操作保持 `NOT_IMPLEMENTED`。
- 新模块：`store/objects.ts`（内容寻址正文）、`documents/service.ts`（文档服务 + `canRead` 可见性矩阵）、`documents/checkpoint.ts`（`buildCheckpoint`/`getLatestCheckpoint`）、`knowledge/transfer.ts`（`exportKnowledge`/`importKnowledge`）、`sessions/internal.ts`（受信身份解析/主会话/回执）、`internal-store.ts`（模块私有注册表）。
- 新测试入口：`@roledock/core/testing`（`testingOpenPrimarySession`），package exports `./testing`。

**存储**：迁移 002——新增 `read_receipts`、`candidate_updates`、`checkpoints` 表；`document_revisions` 因 visibility CHECK 扩展按 SQLite 惯例重建并回填（校验和迁移机制正常工作，篡改/演进防护测试继续通过）。

**`@roledock/cli`**：新增 `--session` 旗标；`documents list/read/propose/publish`（正文从文件参数）、`knowledge export [share|workspace] [role]`、`knowledge import <bundle-dir>` 接通；documents.* 缺 `--session` → `VALIDATION_FAILED` 结构化错误。

**规范更新**：`objects-and-state-machines.md` §5 可见性四级表 + 咨询分支限制，新增 §5a（读取回执、候选生命周期）、§5b（导出导入规则与过滤）；AGENTS.md 包职责与 testing 入口边界；README 状态。

## 4. 实际运行的验证与证据

2026-10-13 本机（Ubuntu 22.04.5, Node v22.23.2）实际执行：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（src+tests 全量严格检查） |
| `npm test` / `npm run check` | **19 个测试文件、212 个测试全部通过，0 跳过**；连续 3 轮 check 全绿 |
| P2 新增测试 | 44 个（protocol Schema 13、documents 11、checkpoint 3、knowledge transfer 7、CLI P2 3、store/coordinator 既有断言更新若干），覆盖上述全部验收路径 |

测试要点（真实断言）：可见性矩阵（同角色主会话/他角色/请求分支 × 四级）；回执绑定与伪造；候选采纳/过期采纳/内容保留；checkpoint 快照精确性与未发布排除；share 导出排除断言；往返哈希一致；篡改零改动；手改包夹带跳过；夹具边界（操作面/CLI 不可达）。

## 5. 失败、跳过、未验证与外部阻塞项

- **无跳过的测试，无失败遗留。** 开发过程中修复的问题：迁移 1 的 document_revisions 带旧 3 值 visibility CHECK，public 发布触发约束失败——迁移 2 按 SQLite 惯例重建该表并回填（校验和机制对旧库正确报错后升级，错误信息可读）；`coordinatorOperations` 反射与测试辅助函数的两处实现瑕疵同步修正。
- **未验证：远程 CI**（沿用待确定项 O-2，无远程仓库）。
- **明确不声称**：sessions.open/恢复、交接（prepare/activate）、请求（create/get/reply/cancel）、artifacts 均未实现（9 个操作 `NOT_IMPLEMENTED`）；无模型摘要服务、无向量检索；夹具不是公开权限面（生产会话创建在 P3）。
- **设计记录**：CLI 不铸造会话（`--session` 需既有会话 id）；P2 夹具的代次递增不走交接校验（仅测试路径，P3 生产路径取代）；导入的候选在目标文档未发布时（latest 0 < baseline）无法立即采纳——按"候选等待所有者工作基线追上"语义处理，报告记录。

## 6. 下一阶段可用输入与尚未满足的退出条件

**P3 可直接使用**：sessions 表与受信身份解析（`resolveSessionIdentity`）、`openPrimarySession` 内部函数（P3 sessions.open 将以交接校验取代夹具语义）、checkpoints 表与 `buildCheckpoint`/`getLatestCheckpoint`（handoffs.prepare 直接复用）、BootstrapBundle Schema（P0 已固化）、agent_instances 退休标记（旧实例撤权路径已就绪）、回执与候选（P4 消费）。

**P2 退出条件核对**：所有权、并发发布和可见性测试通过 ✅（见 §2 对照）。

按流程，下一步把 `prompts/REVIEW.md` 交独立验收 Agent 验收 P2（基线以 `git log` 为准，HEAD 为本报告提交）；验收通过前不执行 P3。
