# P6-G1 独立验收：桌面外壳与服务生命周期

最新裁定：见 [P6-G1-final-review.md](P6-G1-final-review.md)，第二次返工独立复验 **PASS**，G1-R01–R04 全部关闭。以下保留历史验收原文。

最新返工复验：见 [P6-G1-rework-review.md](P6-G1-rework-review.md)，仍为 **REWORK**；R01/R03 已关闭，R02/R04 部分关闭。下文保留首轮验收历史。

日期：2026-10-26。结论：**REWORK**。常规启动、隔离桥、单 writer 和部分恢复路径通过；附着客户端、重复打开后的进程归属、关闭所有窗口后的重开存在可复现故障，且一项 G1 定档查询契约未交付。前置 G0 返工亦仍为 REWORK。

## 1. 范围与基线

依据：AGENTS、开发蓝图、toolchain、桌面计划 §4/§9、ADR-0013、GUI 契约 v2、`prompts/COMMON.md`、`prompts/REVIEW.md`、`prompts/06G1-shell-and-runtime.md`；被验收报告为 [P6-G1-development.md](P6-G1-development.md)。

HEAD `d9743365256459a773a5319791cf3b7bb2e5fbe7` + 当前 G0/G1 未提交工作区。基线状态及源码／测试／契约 40 文件哈希见 [独立证据目录](evidence/2026-10-26-p6-g01-independent/)。验收前后这些文件未变化；保留全部既有改动，没有修产品、提交或发布。

G1 报告 §0 已如实披露按用户指示在 G0 复验前开工。本轮按用户要求同时验收，不将此偏差当作需要再次询问授权的事项；**实际前置仍未通过**，见 [G0 返工复验](P6-G0-rework-review.md)。以下对 G1 本身独立给出技术裁定，不因前置失败省略检查。

## 2. 验收条件对照

| 条件 | 实际证据 | 判定 |
| --- | --- | --- |
| main / preload / renderer / runtime 分层、导航壳、统一错误、G-min 模块化 | `src/shell/`；共享 `gmin/confirm.ts`；G-min 既有三测试独立通过；未新增 core 业务角色 | 满足当前外壳范围 |
| 凭据只在受信层，封闭具名 IPC，无通用 RPC／Shell／renderer Node | 闭合清单；handler 来源检查；实际窗口 nodeIntegration=false / contextIsolation=true / sandbox=true；现有 E2E 通过 | 当前正常入口通过；G0 R01 的公开值误脱敏同样存在于 shell 副本，须一并修复 |
| 独立锁定 Node、结构化 spawn、不手输 owner 文件 | 空 mock 工作空间启动成功，独立 Node 路径，env 最小化，具名目录选择 | 满足已测启动路径 |
| 两窗口同 writer、异常端点不覆盖 | E2E 实际同 pid / workspace_id、第二 SQLite 连接 BUSY；宽权限和非 socket 端点拒绝 | 满足已测路径；不代表所有来源组合均已测试 |
| 附着外部服务、健康刷新、确认页可用 | 只存运行状态，未存 owner credential；后续诊断／角色读取失败，退出后刷新仍 running | **R01 未满足** |
| 默认只回收本应用进程、重复打开／切换保持归属 | 正常一次启动退出可回收；同目录再次 open 会丢失 owned | **R02 未满足** |
| 关闭窗口保留服务且 GUI 可恢复 | 服务确实保留；关完窗口再启动仍 0 窗口 | **R03 未满足** |
| ServiceClient 等待期限与有界停机 | 默认 30s，本地超时错误明确需对账，黑洞／正常响应测试通过；SIGTERM→宽限→SIGKILL 实现存在 | 满足当前客户端与正常停机验证；未把真实执行中强停恢复算成本轮通过 |
| G0 定档的 G1 `workspace.info` 扩展 | service 仍仅返回 workspace_id，外部服务 pid／形态／版本等缺失 | **R04 未满足** |
| 无真实宿主闭环冒充 | 本轮仅 mock 服务；未消费模型任务，未声称 G2/G3 已实现 | 满足 |

## 3. 必须返工

### G1-R01 — [P2] 首次附着没有保存凭据，显示连接成功但 owner 功能不可用

**位置**：`packages/desktop/src/shell/supervisor.ts:66–69、171–175`；`main/workspace-controller.ts:58–84`。

**触发**：先在临时工作空间独立启动正常 mock service，再由新 supervisor/controller 调用 open。探活成功并返回 running，但成功分支未把 `endpoint.credential` 存入 handle。

**独立结果**：`ownerClientPresent=false`；`diagnostics()` 与 `confirmRoles()` 均报“当前工作空间没有可用的 owner 连接”。停止外部服务后调用 refresh，仍返回 `state=running`、`lastRefreshAt=null`，因为无凭据直接提前返回。见 [04-supervisor-repro.json](evidence/2026-10-26-p6-g01-independent/04-supervisor-repro.json) 的 attach 节。

**影响**：UI 重启后附着原服务看似恢复，实际诊断与 G-min 确认页均不可用，手动刷新也不能识别已断开。

**修复要求**：附着成功后仅在受信层持有已验证客户端／凭据，使读取、确认与健康检查可用；刷新如实更新观察时间和连接状态。仍不得将凭据传入 renderer，也不得停止外部服务。

**复验**：新实例附着后通过实际 IPC 执行 diagnostics、listRoles、listSessions；杀死自建的外部服务后 refresh 变为 disconnected；退出 GUI 不杀外部服务。现有 E2E 的“仅 status 相等”不足。

### G1-R02 — [P2] 再次打开自有工作空间会降为外部服务，退出遗漏回收

**位置**：`packages/desktop/src/shell/supervisor.ts:61–69、208–215、190–194`。

**触发**：本应用 open 一个空工作空间到 running，再 open 相同目录（包括从另一工作空间切换回来）。成功探活统一写 `owned=false,pid=null`；`#put` 合并后保留 child，但归属标记已丢失。

**独立结果**：同一 workspace_id 从 owned=true 变 false；调用 `reapOwned(500)` 得 `[]`，原 service PID 仍存活且 RPC 仍能读。见 [04-supervisor-repro.json](evidence/2026-10-26-p6-g01-independent/04-supervisor-repro.json) 的 reopen 节。复现脚本最后单独回收了该验收进程，未遗留它。

**影响**：默认“退出停止本应用服务”设置失效，存活 writer 失去本应用生命周期管理；再次打开也使“停止／重启”语义错误。

**修复要求**：同一存活自有进程的重开必须保留可信归属与 child/pid；仅真正外部服务标为 attached。工作空间路径应归一化，避免路径别名造成重复 handle；保护 open/restart/stop 的并发与归属更新，不用“停止所有端点”代替正确归属。

**复验**：A→A、A→B→A、同目录规范路径／别名和并发双窗口打开后，仍只有一个 writer，原 owned/pid 一致；默认 quit 回收所有自有服务，外部服务继续存活。

### G1-R03 — [P2] 所有窗口关闭后，再次启动无法恢复 GUI

**位置**：`packages/desktop/src/shell/main/index.ts:30–35、51–53`。

**触发**：关闭全部 shell 窗口；进程按设计后台保留。再次启动相同 userData 的应用，第二实例被拒，原实例的 second-instance 处理器只遍历已有窗口，无窗口时不创建。

**独立结果**：真实 Electron 下窗口数 `1→0`，自有服务仍存活；再次启动 exit 0 并输出 single-instance-refused，原实例窗口数仍为 0。webPreferences 与进程观测见 [06-window-reopen.json](evidence/2026-10-26-p6-g01-independent/06-window-reopen.json)。

**影响**：常规关窗后无法通过重新打开应用回到管理界面，后台仍持有服务；无可操作窗口时也无法使用页面控制。

**修复要求**：在“后台保留服务”的既定策略下，无窗口的 second-instance／适用 activate 入口应重新创建受限 shell 窗口，复用原 controller/supervisor。保留已有窗口的聚焦逻辑，不启动第二服务，不靠撤销授权或杀进程恢复 UI。

**复验**：真实应用启动服务→关全部窗口→再次启动→出现窗口且 workspace_id/pid 不变→诊断可用→显式退出回收自有进程；窗口仍存在时二次启动只聚焦原窗口。

### G1-R04 — [P2] 定档为 G1 的 workspace.info 扩展未交付

**位置**：`docs/spec/desktop-gui-contract.md:38、62`；`packages/service/src/index.ts:126`；开发报告 §5 第 4 项。

**触发与结果**：契约把 service 形态／启动参数／版本／adapter 标识／锁持有 pid 的 workspace.info 扩展明确列入 G1，实际 handler 仍仅 `{workspace_id}`。开发报告将附着外部服务 pid 未知记为“非缺口”，没有说明与候选定档契约的差异。

**影响**：G0→G1 接口交付与报告不一致，现有 UI 不能核对附着服务的形态与运行信息。

**修复要求**：按 G0 定档实现有限的 owner 读投影，先补 Schema/类型；参数只暴露非敏感配置，不能返回凭据/helper 输出。若确需移动到 G2，应先明确修订契约与计划的阶段归属并解释范围变化，不能把已定档必需项当作不存在。无需提前实现 G2 的完整真实接入预检。

**复验**：实际服务 RPC 与具名 IPC 返回约定信息，确认来自当前服务；版本、adapter、pid 等与启动进程一致且无秘密字段。若阶段归属修订，开发报告和验收矩阵须一致。

## 4. 独立执行与证据

Node 22.23.2 / npm 10.9.8；真实 Unix socket 与 Electron 验证使用临时工作空间和独立 userData，经本地自动审批运行。没有真实 Harness／模型操作、系统安装或远程发布。

| 命令／验证 | 结果 | 证据文件（同目录） |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `01-typecheck.log` |
| vitest：desktop、probe-contract、shell-contract、service、client-timeout、mcp 六文件 | **27/27 PASS**，exit 0 | `02-targeted-tests.log` |
| `npm run desktop:build:shell` | exit 0 | `03-build-shell.log` |
| 独立 supervisor/controller 实际 mock 服务反例 | 脚本 exit 0；R01/R02 反例成立 | `repro-supervisor.mjs`、`04-supervisor-repro.json/.stderr` |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts` | **4/4 PASS**，exit 0 | `05-shell-e2e.log` |
| 独立真实窗口关闭／再启动 | 脚本 exit 0；R03 反例成立 | `repro-window-reopen.mjs`、`06-window-reopen.json/.stderr` |
| G0 探针重建和真实 E2E | build exit 0，**1/1 PASS** | `07-build-probe.log`、`08-probe-e2e.log` |

打包结果补充于下节。现有测试通过说明已覆盖路径可运行，不能覆盖反例。源码检查未见具体业务角色进入 `packages/*/src`；示例与测试角色保持为数据。ServiceClient 增量未改变角色授权守卫；G-min 逻辑抽取的三个既有行为测试通过。

本轮没有重跑 `npm ci` 或全量 `npm run check`；开发方 45 文件／487 测试全绿仅作开发证据。未将真实执行中强停后全链对账、原生目录真实点选、真实 ZCode 主会话、deb 安装／升级／卸载计为已验收成功；后两类按 G3/G7 单独验收。

## 5. 打包冒烟

- `npm run desktop:package:shell` **exit 0**，从当前源码重建 Linux dir 产物，见 `09b-package-shell-standard.log`。
- 运行该产物的 `packaged-shell-evidence.mjs` **exit 0**；真实窗口打开空 mock 工作空间，状态 running、owned=true，见 [10-packaged-shell.json](evidence/2026-10-26-p6-g01-independent/10-packaged-shell.json)、同名截图与 `.log`。使用产品自己的锁定运行时资源路径；本轮不计为 deb 安装验证。
- 首次仅直接调用 electron-builder 的尝试 **exit 1**（`09-package-shell.log`）：此前验收方重建 G0 探针已清理共用 `dist-desktop`，shell 入口不存在。这是验收命令顺序导致的构建产物缺失；随后改用完整标准命令先构建 shell 后打包成功，不列为产品返工项。两次日志均保留。

## 6. 结论与下一步

**G1 REWORK**。先完成 G0 剩余 R01/R03，以及本报告 G1-R01–R04，记录新基线和针对性回归，再独立复验。G0 与 G1 均未 PASS，**不进入 G2**。本轮交付仅为验收报告和可重跑证据，未修改产品来消除失败。
