# P5 当前工作区复验（2026-10-13）

本轮结论：**REWORK**。基线为 `a083874e60e7a40d88a18e075b699b1fb818b0e1` + 当前 P5 未提交实现；现有 279 项测试全通过，但专项反例改变了受影响阶段的结论。

返工／缺口：R07/R10–R15；另保留 G01 真实 Harness 的 BLOCKED 外部缺口。

逐项验收条件、问题优先级、触发方式、位置、影响、修复和复验方法统一见 [P0–P5 复验报告](P0-P5-revalidation.md)。本轮只改验收与计划材料，保留产品实现。新 GUI 要求另见 [桌面实施计划](../DESKTOP_GUI_PLAN.md)，不追溯作为旧阶段缺陷。

---

> 以下为此前验收报告原文，保留历史证据。其结论仅对应当时验收范围；当前继续开发门槛以上面的本轮结论为准。

# P5 独立验收报告：Harness 接入与端到端演示

- 阶段：P5（Harness 与演示）
- 日期：2026-10-13
- 验收 Agent：ZCode（GLM，独立验收）
- 验收依据：`prompts/REVIEW.md`、`prompts/05-harness-and-demo.md`、`prompts/COMMON.md`、`docs/DEVELOPMENT_PLAN.md`（§8）、`AGENTS.md`、`docs/phase-reports/P4-review.md`
- 被验收报告：`docs/phase-reports/P5-development.md`

## 结论：**BLOCKED**（部分验收：可交付部分全部通过；唯一缺口为需用户授权输入的真实宿主闭环）

可独立完成的全部交付物（process-bridge 适配器、共享契约套件、CLI 收口、可重跑演示、文档）经独立验证**全部合格**；开发报告对真实宿主缺口的声明诚实、缺口清单具体，符合阶段提示词任务 4 与蓝图 §8 的要求。阶段验收条件 2 的主分支（"至少一个已配置真实 Harness 完成角色载入、继承和独立请求"）缺少**无法由当前实现补齐的外部输入**——已授权的真实宿主访问（用户已确认当前无）——按 `prompts/REVIEW.md` 的 BLOCKED 定义（该文件即以"真实宿主访问"为此类情形的示例）记录本结论。**在缺口关闭前不标记"原型全部通过"或 v0.1 原型达成**（蓝图 §8）。

## 1. 验收基线

| 项 | 值 |
| --- | --- |
| HEAD | `a083874`（P4 开发报告提交）——**P5 交付尚未提交，全部位于工作树**（修改 14 个文件 + 新增 process-bridge/、演示、契约套件、文档等） |
| 验收对象 | 工作树当前内容（`git diff a083874` + 未跟踪新增文件），验收时工作树除 P5 交付与验收方的 `P4-review.md` 外无其他改动 |
| 流程事项 | 开发报告 §1 以"提交"描述基线，但 P5 实现与报告提交在验收时尚未创建（见 §4 流程事项 N-1）；本验收以工作树为对象，结论在提交内容与验收所见一致的前提下有效 |

## 2. 独立执行的验证与结果

| 验证 | 结果 |
| --- | --- |
| `npm ci` → 立即 `npm run check`（CI 等价序列） | **全绿：26 个测试文件、279 个测试全部通过，0 跳过** |
| `npm run check` 第 2、3 轮 | 全绿 ×2（279/279），与开发报告一致 |
| 演示手工运行 | `demo.mjs --adapter bridge` ×2 与 `--adapter mock` ×2 全部 **7/7 通过**（退出码 0）；每次运行全新工作空间、会话 ID 各自独立 |
| CLI 机器输出纯净性 | `--json` 单信封可被独立 JSON.parse（人工说明走 USAGE/stderr，不混入 stdout） |
| 日志凭据扫描 | `demo-log.jsonl` 中 token/secret/password/credential/api-key 零命中 |
| 业务角色名 / 跳过测试 / shell 拼接独立 grep | 各自零命中（桥接 spawn 仅 argv 数组，材料走 stdin/文件） |

## 3. 验收条件逐项核验

### 条件 1：Mock 与真实进程桥接通过同一适用契约测试；失败能力返回明确降级状态 — ✅

- `tests/conformance/adapter-suite.ts`（9 用例：能力声明完整性、隔离缺失降级 restricted、bootstrap 宿主侧哈希校验拒篡改、同键幂等、无 bootstrap 可选、turn/result 计数、创建键查找命中与未命中、close 后拒绝）由 `adapters/mock/test/contract.test.ts` 与 `adapters/process-bridge/test/contract.test.ts` **各自实例化**，同一套件双实现全绿——"同一适用契约"的要求以字面满足。
- 桥接 `nativeResume/nativeFork` 如实声明 false；resume 走降级路径返回 `resumed:false` 并指向语义继承（P3 机制，桥接下实测）。
- 桥接真实进程测试（6 用例）：敌意创建键证明元字符不落 shell（`key;$(touch …)` 断言文件未产生）；断线（crash-turn 丢 ack）后新适配器实例按创建键恢复持久真相；uncertain-create 留下可恢复注册表而非重复；crash-load 硬失败无宿主残留；3 并发会话独立目录与 transcript；closeSession 回收 tmp 并闭合注册表。

### 条件 2：至少一个已配置真实 Harness 完成闭环；无条件时报部分完成 — ❌（缺口即 BLOCKED 本体）

- 真实宿主闭环**未完成**：当前环境无已授权宿主（开发报告记录用户 2026-10-13 确认）。
- 部分完成声明的诚实性核验：报告 §5 明确不声称真实闭环通过；fixture-host 程序头注与演示日志均明示 "PROTOCOL FIXTURE, not a model, not a real harness"、"model: none (fixed-answer protocol fixture)"；`harness-reference/` 未建空壳包（符合 AGENTS.md"不放置不可运行的空壳包"）。
- 所缺输入清单具体可执行（`docs/adapter-guide.md` §7 + `adapters/README.md`）：① 宿主名称与版本及官方 CLI/SDK 无头调用方式（官方资料核查、不猜参数）；② 授权范围（凭据/配额/任务类别）；③ 验收证据要求（角色载入、上下文隔离、去凭据日志）。
- **影响**：v0.1 原型通过条件（蓝图 §9.2"至少一个真实 Harness 完成角色载入、交接和独立请求"）未满足；"原型全部通过"与 v0.1 达成标记被阻断。P6 的可独立完成部分不受阻（蓝图 §8 明示）。

### 条件 3：CLI JSON 返回可供另一个 Agent 解析，人工说明不混入机器输出 — ✅

手工验证：`--json` stdout 为单个可完整解析的信封（`roles list` 解析得 4 角色）；错误信封走 stderr；USAGE 人工文本不进入 `--json` 输出。demo 脚本本身即"另一个 Agent"：逐信封 `JSON.parse` 驱动全部 7 步（集成测试两遍验证）。

### 条件 4：演示可重跑、不污染既有会话；迁移只恢复已持久化语义知识 — ✅

- 集成测试连续两遍（bridge、真实子进程）通过；验收方手工再跑 bridge ×2 + mock ×2 均通过；每次运行 `mkdtemp` 全新工作空间，日志断言会话 ID 集合无重复（第二次运行未复用第一次的会话）。
- 迁移仅 share 范围（project/public），导入为候选（P4 已验收机制），私有/未声明条目跳过——迁移只恢复已持久化语义知识，不含私密聊天或隐藏状态。

### 条件 5：真实执行日志保留适配器、宿主及模型版本和结果引用，去除敏感凭据 — ✅

`demo-log.jsonl` 首行记录 adapter 名称与版本、`host_version:"0.1.0-fixture"`（宿主程序自报）、`model:"none (fixed-answer protocol fixture)"`；每步携带 session/instance/bundle/request/artifact 引用与时间戳；验收方凭据扫描零命中（演示全程无凭据输入）。

## 4. 专项与约束检查

- **历阶段观察项关闭核验**：O-5 关闭（CLI `--adopt-artifact` 旗标 + `admin inbox/events` 诊断命令，代码与测试在位）；O-6 关闭（预算优先取宿主 `output_bytes`，缺省回退材料字节数，executor 实测）；O-7 关闭（`ExecutionResult` 重复声明已删除，grep 仅 1 处）；交接 provisioned 会话行 adapter 列改用 `adapter.getCapabilities().adapter`（不再硬编码）。
- **任务 8 文档**：`docs/adapter-guide.md` §6 明确"仅接 MCP 工具不构成会话接管，角色载入须在首个工作轮次前经启动钩子/wrapper"——与蓝图 §6 的区分要求一致；`docs/quickstart.md` 固化 CLI 命令。
- **WorkspaceAdmin 诊断面**：`showInbox`/`showEvents` 为只读所有者面，不进 18 操作面（conformance 不变）。
- **P0 硬约束延续**：核心与两个适配器无业务角色；无跳过测试；Mock/fixture 未被写成真实宿主证据（适配器指南、宿主程序、日志三处明示）；依赖零新增（仅 node:child_process）。
- **规范/配置同步**：适配契约文档、根 tsconfig references、vitest 通配纳管桥接包。

## 5. 问题清单

无代码返工项。流程事项与非阻塞观察项：

| 编号 | 优先级 | 说明 |
| --- | --- | --- |
| N-1 | P1（流程） | **P5 交付未提交**：开发报告 §1 以提交描述基线，但验收时 P5 实现、报告乃至 `P4-review.md` 均在工作树未提交。验收结论对应工作树内容；**定稿动作：将 P5 交付按报告 §1 所述提交序列入库，提交后内容须与本验收所见一致**（差异需重验受影响项）。 |
| GAP-1 | P0（缺口本体） | 真实宿主闭环：需用户提供 ①宿主名称/版本与官方无头调用方式、②授权范围。具备后按 `adapter-guide.md` §7 实现 harness-reference 并完成角色载入、继承、独立请求闭环，再复验本条件；在此之前不标记 v0.1 原型达成。 |
| O-1 | P3 | no-business-roles 扫描名单范围（历阶段延续）。 |
| O-2 | P3 | 远程 CI 与托管位置待用户决策（P0 起延续）；本阶段 CI 等价序列首轮即全绿。 |

## 6. 下一步（必须完成）

1. **用户决策（解除 BLOCKED 的唯一路径）**：确定一个已授权的真实 Harness 并提供 §5 GAP-1 所列输入；或不提供宿主、明确指示以"真实闭环缺口挂账"的方式进入 P6（蓝图 §8 允许——P6 的可独立完成工作不需要真实宿主，但 v0.1 原型达成标记持续被阻断）。
2. **开发方定稿**：将 P5 交付按报告 §1 入库（N-1），使基线可追溯。
3. 若用户提供宿主输入：开发方按 `adapter-guide.md` §7 清单实现 `harness-reference`，完成角色载入、继承、独立请求闭环与去凭据日志后，交验收方复验条件 2（复验范围仅限该条件及其回归）。
4. 本验收流程不授予代码合并或远程发布权限。
