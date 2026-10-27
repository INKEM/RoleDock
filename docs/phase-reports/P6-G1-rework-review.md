# P6-G1 返工独立复验

最新裁定：见 [P6-G1-final-review.md](P6-G1-final-review.md)，本次剩余返工独立复验 **PASS**，R02/R04 已关闭。以下保留上轮 REWORK 历史。

日期：2026-10-26。结论：**REWORK**。G1-R01、G1-R03 已关闭；G1-R02 的正常重开／归属修复通过，但启动中与信号退出边界仍有缺陷；G1-R04 已交付运行信息，尚缺要求的协议 Schema。不得进入 G2。

## 1. 范围与基线

依据 `prompts/REVIEW.md`、G1 提示词、开发蓝图、toolchain、桌面计划 §4/§9、ADR-0013、GUI 契约 v3 和 [上一轮 G1 验收](P6-G1-review.md)。被验收内容为 `P6-G1-development.md` §9，及 G0 开发报告 §10。

实际基线：HEAD `d9743365256459a773a5319791cf3b7bb2e5fbe7` + 当前 G0/G1 返工未提交工作区。源码、协议 Schema、配置／锁文件、测试与被审查开发材料共 76 文件前后哈希一致，见 [基线核对](evidence/2026-10-26-p6-g01-rework-independent/baseline-verification.json)。本轮只新增／更新验收报告和复现材料，未修产品、未提交或发布。

本轮同时复验 G0，其最新结论见 [G0 最终复验](P6-G0-final-review.md)。G0 的技术与契约裁定不包含 G1 生命周期实现通过。

## 2. 上轮问题关闭矩阵

| 原项 | 本次裁定 | 独立证据 |
| --- | --- | --- |
| G1-R01 附着后无可用 owner 客户端 | **关闭** | 新 supervisor 附着真实外部 mock 服务后 diagnostics、listRoles、listSessions 均可用；观察时间／pid 正确，外部服务退出后 refresh 为 disconnected；真实 IPC E2E 回归通过 |
| G1-R02 重开丢失归属 | **部分关闭，仍需返工** | A→A、A→B→A、realpath 别名保留 owned／pid，两自有服务均正常回收；新快路径错误覆盖 starting 与信号结束的旧 child，见 §3 |
| G1-R03 关闭全部窗口后无法重开 | **关闭** | 实际 Electron E2E 再次启动恢复原窗口、相同 workspace_id／pid，诊断成功，最后退出回收服务 |
| G1-R04 workspace.info 扩展缺失 | **部分关闭，仍需返工** | 真实 RPC 已返回 version/pid/started_at/adapter/runtime，runtime=v22.23.2，UI 诊断可显示；新增的协议代码只有 TS interface，JSON Schema 与注册仍缺 |

G0-R01 的两个桥接副本均独立验证公开哈希／标识保真、秘密字段省略、自由文本标注型秘密掩盖，未发现原误脱敏问题继续存在。

## 3. 必须完成的返工

### G1-R02（续）— [P2] 复用旧句柄前没有区分启动中、运行中与已被信号结束

**位置**：`packages/desktop/src/shell/supervisor.ts:76–87`，以及同文件 stop/restart/reapOwned 的 child 存活判定。

**触发 A：服务被 SIGKILL 后，重新打开原目录。**

本轮对临时工作空间正常 open 到 running，SIGKILL 仅结束本次验收自建的 service，等待 supervisor 收到 exit 并记录 disconnected，再 open 同一目录。实际返回仍是旧 `disconnected`、`pid=null`，没有启动新服务；原 owner RPC 不可连接。原因是信号结束后 `ChildProcess.exitCode` 仍为 null，快速分支却以 `exitCode===null && state!==stopping` 当作存活，直接复用旧句柄。

**触发 B：首次启动尚未就绪，另一窗口／调用同时 open 相同目录。**

同目录两个 open，第二个约 **2ms** 返回 `starting`、`workspaceId=null`、ownerClient 不存在；第一个约 **3118ms** 后才返回 running。两个 Promise 不同。`#opening` 检查位于快速分支之后，启动时已经创建的 owned handle 先被命中，未共享进行中的启动结果。该反例仍只有一个 writer，问题是第二个调用提前完成，无法据 open 完成执行后续 owner 操作。

**证据**：[05-supervisor.json](evidence/2026-10-26-p6-g01-rework-independent/05-supervisor.json) 的 `crashReopen`／`concurrentOpen` 节。复现源码为同目录 `revalidate-supervisor.mjs`，使用当前 supervisor 源码与真实 mock service，无延迟／固定回答服务夹具。

**影响**：选择目录重开不能恢复异常退出的服务；并发调用在就绪前获得成功返回，而开发报告所述“同目录共享一个 in-flight Promise”未成立。已有 crash E2E 调的是 restart，它经过 stop 清句柄，不能证明 open 的信号退出恢复已通过。

**修复要求**：统一真实 child 结束状态与句柄状态判定，正确处理 signalCode／exit 事件；仅复用可用的运行中自有服务。先处理同目录进行中的打开，使所有等待者获得同一就绪／失败结果。保持正常重开的归属、路径归一化、单 writer 和外部服务不回收约束；无须引入自动重启后台任务。

**复验**：SIGKILL→等待 disconnected→再次选择同目录应恢复同 workspace_id、新 pid、可用 diagnostics；正常 A/B/别名重开仍保留归属；两个窗口同时首次 open 均在实际就绪后完成（失败时均获得失败结果），然后退出全部自有 PID 消失、外部服务存活。停止／退出已结束的 child 也不应等待一个不会再次发生的 exit 事件。

### G1-R04（续）— [P2] 新读模型仅有 TS 类型，尚未建立 Schema 权威契约

**位置**：`packages/protocol/src/types.ts:393–406`、`packages/protocol/src/validate.ts` 的 SchemaName／SCHEMA_NAMES、`packages/protocol/schemas/`；`packages/service/src/index.ts:131–138`。

**已通过部分**：真实工作空间 info 返回稳定 workspace_id 与运行信息，diagnostics 的 service.pid 与启动服务一致、runtime 为 v22.23.2、adapter 为 mock；输出未包含 argv、路径或凭据。扩展后的重启集成测试验证新进程 pid／started_at 与稳定 workspace_id 的区分，本轮独立重跑通过。

**剩余证据**：新增协议内容仅 `WorkspaceServiceInfo` interface。Schema 目录及 Schema 注册表都没有该响应结构，`SCHEMA_NAMES` 中没有对应项，见 `05-supervisor.json` 的 protocol 节及当前文件；不存在可用于验证这个 DTO 的协议 Schema。泛型 `call<WorkspaceServiceInfo>` 不执行运行时验证。

**影响与依据**：上轮 R04 已明确要求“先补 Schema/类型”，GUI 契约 §2.1、§3.1 也将此作为实现纪律，AGENTS 规定 Schema 是代码侧契约权威。实际运行成功可关闭数据缺失问题，不能替代 Schema 交付；这里不声称已观察到恶意服务或凭据泄露。

**修复要求**：补充与当前公开投影一致的 JSON Schema、SchemaName／SCHEMA_NAMES 注册与类型一致性；在该读模型的传输／消费边界按项目惯例验证。保留对非敏感运行信息的有限投影，不为补契约扩展到 G2 真实预检。同步文档中的“全部未实施／workspace.info 仅有 id”等旧盘点说明，明确历史基线与当前实现。

**复验**：实际 service 返回通过协议验证；缺字段、错误 pid 类型／范围、错误时间格式、未允许的秘密字段等非法输入有明确失败断言；service-restart、desktop／MCP 与独立 Node bundle 回归保持通过。

## 4. 本轮独立运行

证据统一位于 [2026-10-26-p6-g01-rework-independent](evidence/2026-10-26-p6-g01-rework-independent/)。采用 Node 22.23.2 / npm 10.9.8；Unix socket、子进程与 Electron 经本地自动审批运行，均使用临时 mock 工作空间与隔离 userData。没有真实模型调用、系统安装或远程发布。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `01-typecheck.log` |
| `npm run desktop:build:shell` | exit 0 | `02-build-shell.log` |
| vitest：desktop/probe-contract/shell-contract/service/client-timeout/mcp/service-restart/no-business-roles | **8 文件、96/96 PASS**，exit 0 | `03-focused.log` |
| shell 真实 Electron E2E | **5/5 PASS**，exit 0；包含本次扩展的附着查询、重开归属和无窗口恢复 | `04-shell-e2e.log` |
| 独立 supervisor/controller 边界检查 | 正常修复通过；SIGKILL 后 open 与并发首次 open 的反例成立 | `05-supervisor.json/.stderr`、`revalidate-supervisor.mjs` |
| 两个桥接源文件合成公开值／脱敏检查 | 全部保真与秘密字段／文本断言通过，exit 0 | `06-redaction.json`、`revalidate-redaction.mjs` |
| G0 探针当前源码重建／真实窗口 | build exit 0，E2E **1/1 PASS** | `07-build-probe.log`、`08-probe-e2e.log` |

G0 打包复验见其最终报告。本轮不另重建 G1 安装产物；此前 G1 dir 打包的通过属于旧基线，未写成本轮重新执行。未重跑 `npm ci` 或全量 `npm run check`；开发方 45 文件／489 测试全绿仅作为开发证据。原生目录真实点选、真实 ZCode 主会话接入、deb 安装／升级／卸载继续按既定后续阶段验收。

## 5. 下一步

补齐 **G1-R02、G1-R04**，保留 R01/R03 已关闭记录，并对改动相关路径独立复验。当前 G1 **REWORK**，不进入 G2。正常路径与既有 E2E 全绿不能替代本次新增边界反例的关闭。
