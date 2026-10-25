# P5 开发报告：Harness 接入与端到端演示

- 阶段：P5（Harness 与演示）
- 日期：2026-10-13
- 开发 Agent：ZCode（GLM）
- 前置：P4 已通过独立验收（`P4-review.md` 结论 PASS，基线 `a083874`）
- 状态：**待独立验收；按蓝图 §8 记为部分完成**（真实宿主闭环缺失，见 §5——已与用户确认当前无已授权的真实 Harness）

## 1. 实际基线

2026-10-13 复验更正（N01）：以下原报告中的提交和“干净工作树”表述没有实际提交证据。验收对象为 HEAD `a083874e60e7a40d88a18e075b699b1fb818b0e1` 加已有 P5 未提交工作区，本轮保留这些改动且未提交。原报告的 PASS／全绿记录是历史开发声称，不能替代 [P0–P5 独立复验](P0-P5-revalidation.md) 与 [P5-R 开发报告](P5-R-development.md) 的当前运行证据。P1–P5 的当前基线已判为 REWORK；真实 Harness 缺口 G01 仍未关闭。

| 提交 | 内容 |
| --- | --- |
| `098f346`…`a083874` | P0–P4 已验收基线 |
| 未提交工作区 | P5 实现：process-bridge 包、共享契约套件、CLI 适配器选择/采纳/诊断、可重跑演示、文档 |
| 未提交工作区 | P5 开发报告 |

工作树包含用户既有未提交改动，须保留；本轮不擅自提交。

## 2. 任务完成度与验收条件对照

P5 提示词 8 项任务：

1. ✅ **process-bridge 适配器**（`@roledock/adapter-process-bridge`）：每次操作 spawn 真实 fixture-host 子进程；**argv 数组传参、材料经 stdin/文件，绝不拼接 shell 字符串**（有敌意创建键测试证明元字符不落 shell）；会话状态落盘（`session.json` 注册表/bootstrap/transcript/result/tmp），bootstrap 由宿主侧重算哈希确认；定义了 load/turn/result/close/lookup 消息与结构化错误透传。
2. ✅ **桥接真实进程测试**：断线（crash-turn：ack 丢失→报错且持久状态即真相，新实例按创建键恢复）、创建键查找（含 uncertain-create：注册表已写→宿主可能已创建→`execution_uncertain`→lookup 续接）、并发独立会话（3 会话独立目录/transcript 互不串扰）、资源回收（close 移除 tmp、注册表置 closed、lookup 不再返回）。固定回答程序仅作协议夹具（日志明示 `model: none (fixed-answer protocol fixture)`）。
3. ⚠️ **真实 Harness**：未交付。当前环境无已授权真实宿主（**用户已确认**）。所缺输入：宿主名称与版本、官方 CLI/SDK 及无头调用方式、授权范围（凭据/配额/任务类别）。清单化记录于 `docs/adapter-guide.md` §7 与 `adapters/README.md`；不创建空壳包，不猜命令参数。
4. ✅ **可独立完成部分全部交付**：适配接口、桥接、测试、CLI、文档（§3–§4）；未宣称真实闭环通过。
5. ✅ **CLI**：`--adapter mock|bridge`（默认 mock）、`documents publish --adopt-artifact`（P4 验收 O-5 关闭）、`admin inbox [role]` / `admin events`（所有者诊断面，O-5 收件箱入口关闭）、USAGE 重写为稳定命令清单。
6. ✅ **demo-team 全流程**：`examples/demo.mjs` 覆盖蓝图 7 步（开会话→发布知识→读取回执+两隔离请求→执行+收件箱→交接 gen2→旧快照保留/新请求绑新代次/旧会话发布被拒→跨适配器导出导入→custom-role 零核心改动）。
7. ✅ **跨适配器迁移 + custom-role**：A 工作空间（bridge，真实进程宿主）导出 share 包 → B 工作空间（mock）导入为候选（0 私有条目）；archivist 会话即开即用。
8. ✅ **文档**：`docs/adapter-guide.md`（端口/降级/三层模型/桥接协议/实现清单 + **宿主启动钩子在首个工作轮次前载入角色 vs 仅接 MCP 工具不等于会话接管**的明确区分）、`docs/quickstart.md`（稳定 CLI 命令）。

P5 验收条件逐项：

| 验收条件 | 证据 |
| --- | --- |
| Mock 与真实进程桥接通过同一适用契约测试；失败能力明确降级 | `tests/conformance/adapter-suite.ts`（9 用例）被 `adapters/mock/test/contract.test.ts` 与 `adapters/process-bridge/test/contract.test.ts` 各自实例化，18 用例全绿；桥接 `nativeResume/nativeFork=false` 如实降级（resume 返回 `resumed:false` + 指向语义继承）；受限等级用例（隔离缺失→`level:"restricted"`）双实现通过 |
| 至少一个已配置真实 Harness 完成闭环；无条件时报部分完成 | **未完成**：无已授权宿主（用户确认）。阶段记部分完成；缺口与所需输入明示（本报告 §5、adapter-guide §7）。不声称"原型全部通过" |
| CLI JSON 可供另一 Agent 解析，人工说明不混入机器输出 | `--json` 信封经协议 Schema 校验（既有测试）；成功信封走 stdout、错误信封走 stderr；demo 脚本即"另一个 Agent"，逐信封 JSON.parse 驱动全流程 |
| 演示可重跑、不污染既有会话；迁移只恢复已持久化语义知识 | 每次运行 mkdtemp 全新工作空间；集成测试 `tests/integration/demo.test.ts` 连续跑两遍全过（7 步日志齐全、会话 ID 各自独立）；导出仅 share 范围（project/public，无 checkpoints/私有材料），导入侧即使手改包夹带私有条目也跳过（P4 已验收机制） |
| 真实执行日志保留适配器、宿主及模型版本和结果引用，去除敏感凭据 | `demo-log.jsonl` JSONL：adapter 名称/版本、host_version（`0.1.0-fixture`，宿主程序自报）、`model: none (fixed-answer protocol fixture)`、每步 session/instance/bundle/request/artifact 引用与时间戳；演示全程无凭据输入 |

## 3. 主要文件与公共接口变化

- **`@roledock/adapter-process-bridge`（新包）**：`ProcessBridgeAdapter`（必选 5 方法 + `cancel`/`lookupSessionByCreationKey`，`nativeResume/nativeFork` 声明为 false）；`isolation` 覆盖（受限等级）、`chaos` 注入（`uncertain-create`/`crash-load`）、`timeoutMs` 选项；`hostVersion()` 观察口；`host/fixture-host.mjs` 固定回答协议夹具（不参与编译，按包相对定位）。
- **`@roledock/core`**：端口 `AdapterSessionResult` 增可选 `output_bytes`（宿主报告，executor 预算优先取宿主值——P4 验收 O-6 关闭）；`WorkspaceAdmin` 增只读诊断 `showInbox`/`showEvents`（不在 18 操作面内，conformance 断言不变）；`requests/executor.ts` 删除重复 `ExecutionResult` 声明（O-7 关闭）；交接 provisioned 会话行的 adapter 列由硬编码 `'mock'` 改为 `adapter.getCapabilities().adapter`。
- **`@roledock/cli`**：`--adapter`、`--adopt-artifact` 全局旗标；`admin inbox [role]`、`admin events` 命令；USAGE 重写。CLI package.json 增桥接依赖。
- **配置**：根 `tsconfig.json` references 与 `tsconfig.check.json` paths 增桥接包；vitest 已有 `adapters/*/test` 通配自动纳管；零新增第三方依赖（仅 `node:child_process`）。
- **文档**：`docs/adapter-guide.md`、`docs/quickstart.md`（均为新增）；`adapters/README.md`、`README.md`、`AGENTS.md` 状态同步。

## 4. 实际运行的验证与证据

2026-10-13 本机（Ubuntu 22.04.5, Node v22.23.2）实际执行：

| 命令 | 结果 |
| --- | --- |
| `npm ci` → `npm run check`（CI 等价序列，第 1 轮） | **全绿：26 个测试文件、279 个测试全部通过，0 跳过** |
| `npm run check` 第 2、3 轮 | 全绿 ×2（279/279） |
| P5 新增测试 | 29 个：契约套件 9×2（mock+bridge 同套件）、桥接专属 6（无 shell/断线/uncertain 对账/硬失败/并发隔离/资源回收）、CLI 3（未知适配器退出码 2、桥接全交接+宿主目录落盘、采纳+收件箱翻转）、演示集成 2（连续两遍 7 步全过） |
| `node examples/demo.mjs --adapter bridge` | **DEMO PASSED — 7/7**；`demo-log.jsonl` 记录 adapter/host 版本与逐步引用 |
| `node examples/demo.mjs --adapter mock`（×2） | 7/7 通过（对照链路与可重跑证明） |

测试构成（P5 新增细节）：契约套件覆盖能力声明/受限降级/bootstrap 篡改宿主拒绝/同键幂等/无 bootstrap 可选/turn-result 计数/lookup 命中未命中/close 后拒绝；桥接专属覆盖无 shell 拼接（敌意创建键）、断线后持久状态即真相、uncertain-create 对账不重复、硬失败无残留、并发会话隔离、close 回收 tmp 与注册表闭合。

开发过程中修复的问题：桥接最初只把 payload 字符串写入 `bootstrap.json` 而宿主按完整 BootstrapLoad 记录解析（哈希校验崩溃）→ 改为整记录传递；demo 的 `drainRequest` 在重复完成抛出时泄漏持锁 Coordinator 导致后续命令 `database is locked` → try/finally 修复；CLI `buildInput` 上下文类型收窄遗漏 `adoptArtifact` → 补齐。

## 5. 失败、跳过、未验证与外部阻塞项

- **真实宿主闭环未完成（本阶段唯一的验收条件缺口）**：当前无已授权真实 Harness（用户 2026-10-13 确认）。**所缺输入**：① 宿主名称与版本；② 官方 CLI/SDK 及其无头/非交互调用方式（将按官方资料核查，不猜测参数）；③ 授权范围（凭据、配额、可执行任务类别）。具备后按 `docs/adapter-guide.md` §7 清单实现 `harness-reference` 并跑角色载入、继承、独立请求闭环；在此之前**不标记 v0.1 原型达成**（蓝图 §8）。
- **无跳过的测试，无失败遗留**（279/279，0 skip）。
- **明确不声称**：fixture 宿主不是模型、桥接通过不是真实宿主证据（适配器指南与日志均明示）；`harness-reference/` 不建空壳；MCP 入口属 P6。
- 历阶段观察项处置：**O-5 已关闭**（CLI 采纳/收件箱入口）、**O-6 已关闭**（预算优先宿主 `output_bytes`）、**O-7 已关闭**（重复接口删除）、**O-8 延续**（真实宿主验证，即本阶段缺口本体）；O-1/O-2 延续（远程 CI 与托管位置待用户决策）。
- 沿用声明：模型 token 计量以宿主报告为准，真实宿主接入时由适配器上报。

## 6. 下一阶段可用输入与尚未满足的退出条件

**P6 可直接使用**：全部 18 操作 + 管理面/诊断面 CLI（`--adapter` 可插拔）；适配器指南与快速开始文档；跨适配器演示材料与 JSONL 日志格式；契约套件（新适配器第三实例化点即插即用）；process-bridge 作为 wrapper 式真实宿主接入的底座。

**P5 退出条件核对**：接口、桥接、测试、CLI、演示、文档全部交付 ✅；"已配置真实 Harness 完成关键闭环" ❌（无授权宿主）→ **阶段整体为部分完成**，真实闭环验证完成前不标记 v0.1 原型已达成（蓝图 §8）。

按流程，下一步把 `prompts/REVIEW.md` 交独立验收 Agent 验收 P5（基线以 `git log` 为准）；验收通过前不执行 P6。
