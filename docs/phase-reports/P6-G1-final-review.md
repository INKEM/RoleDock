# P6-G1 返工最终独立复验

日期：2026-10-26。结论：**PASS**。G1-R02、G1-R04 的剩余返工已关闭，R01/R03 维持关闭；G0 已 PASS，现满足进入 G2 的阶段前置。本轮止于验收，不自动开发 G2。

## 1. 范围与实际基线

依据 AGENTS、开发蓝图、toolchain、桌面计划 §4/§9、ADR-0013、GUI 操作契约、`prompts/COMMON.md`、`prompts/REVIEW.md` 和 `06G1-shell-and-runtime.md`。被验收内容为 [P6-G1-development.md §10](P6-G1-development.md)，前序裁定为 [G1 返工复验 REWORK](P6-G1-rework-review.md)；G0 前置依据 [G0 最终 PASS](P6-G0-final-review.md)。

HEAD：`d9743365256459a773a5319791cf3b7bb2e5fbe7` + 当前未提交工作区。冻结清单包含 desktop、protocol、service 的源码／Schema／测试，构建脚本、锁文件、契约与开发报告，共 **83 文件**，前后哈希一致，见 [baseline-verification.json](evidence/2026-10-26-p6-g1-final-independent/baseline-verification.json)。验收没有修改产品、被审查契约或开发报告；仅新增验收证据、报告和历史报告的最新结论指针。没有提交、合并或发布。

## 2. 返工关闭矩阵

| 原项 | 本轮独立结果 | 裁定 |
| --- | --- | --- |
| G1-R01 附着后 owner 客户端不可用 | 外部 mock 服务附着后 diagnostics、listRoles、listSessions 正常；外部服务结束后 refresh 为 disconnected。真实窗口回归验证 GUI 退出不停止外部服务 | **关闭，维持** |
| G1-R02 进程归属／信号退出／并发就绪 | A→A、A→B→A 与 realpath 别名均保留 owned／pid；SIGKILL 后同目录 open 恢复同 workspace_id、新 pid；并发成功与失败都共享一个 Promise／结果；死亡 child 立即清理，自有服务均回收 | **关闭** |
| G1-R03 无窗口时不能恢复 GUI | 当前真实 Electron E2E 验证关完窗口后再次启动恢复窗口、相同 writer，诊断可用，最终退出回收 | **关闭，维持** |
| G1-R04 workspace.info 缺失／只有类型没有 Schema | 新 JSON Schema、SchemaName／SCHEMA_NAMES 注册、TS 类型和 service 传输边界 validate 均已交付；实际 RPC 合法，非法字段／类型／时间／额外秘密字段被拒绝；新 Schema 已进入实际打包服务资源 | **关闭** |

## 3. 剩余项关闭依据

### G1-R02：信号退出、并发启动与已结束 child

`packages/desktop/src/shell/supervisor.ts` 的同目录 in-flight 查找已前移；快速复用要求 running 且通过统一 `isAlive`。该守卫检查 exit 事件标志、exitCode 和 signalCode，stop/restart/reapOwned 亦使用该判断，避免把 SIGKILL 后 exitCode=null 的旧进程当成存活。

独立脚本从当前源码构建 supervisor/controller，并使用真实 mock service，结果见 [05-boundaries.json](evidence/2026-10-26-p6-g1-final-independent/05-boundaries.json)：

- 两次同目录首次 open 的 `samePromise=true`；返回均为 running，同一 pid／workspace_id，第二个调用返回时 ownerClient 已存在。本轮约 1048ms 共同就绪，未再提前返回 starting。
- SIGKILL 后等待 disconnected，再 open 原目录：从 pid 2364235 恢复到 2364310，workspace_id 仍为 `ws-191554d2`，实际 RPC 成功。
- 非 socket 文件造成启动失败时，两调用共享同一失败结果，哨兵文件原样保留；没有伪造 running。
- 已被信号结束的子进程，stop 与 reapOwned 分别约 1ms／0ms 清理句柄，不等待失效 exit 事件。
- 正常 A/B 切换、路径别名保留自有归属；两个自有 writer 在 reap 后均消失。实际 Electron E2E 另覆盖双窗口一个 writer、SQLite 第二连接 BUSY 与外部服务不回收。

上述脚本的 checks 十项均为 true，脚本 exit 0；复现材料可从仓库根目录用 Node 22.23.2 重跑同目录 `revalidate-supervisor.mjs`，需先 `npm run desktop:build:shell`。脚本仅创建临时 mock 工作空间，结束时回收本次进程。

### G1-R04：Schema 权威、有限投影与打包运行

交付包括 `packages/protocol/schemas/workspace-service-info.schema.json`、Schema 注册、`WorkspaceServiceInfo` 类型；service 在返回投影前调用 `validate("workspace-service-info", projection)`，失败返回 INTERNAL。投影仅有 workspace_id 及 service 的 version/pid/started_at/adapter/runtime，Schema 顶层与 service 层均禁止额外字段。

新增协议专项独立运行通过，包含缺字段、错误 ID、pid=0／字符串 pid、非法时间、非法 adapter、空 runtime、顶层／嵌套 token 与 argv/socket_path 的拒绝。独立边界脚本对真实 RPC 响应再次验证通过，并验证额外合成秘密字段和非法 pid 被拒绝。

实际新打包产物中，GUI diagnostics 返回的投影通过同一 Schema，service.runtime=v22.23.2；`/proc/<pid>/exe` 指向该产物的 `resources/runtime/node/node`。renderer 的 nodeIntegration=false、contextIsolation=true、sandbox=true，无 process/require；退出后自有 service PID 消失。见 [07-packaged-shell.json](evidence/2026-10-26-p6-g1-final-independent/07-packaged-shell.json) 与同名截图。

## 4. 本轮独立验证

统一证据目录：[2026-10-26-p6-g1-final-independent](evidence/2026-10-26-p6-g1-final-independent/)。运行基线 Node 22.23.2 / npm 10.9.8。Unix socket、子进程和 Electron 检查经本地自动审批运行，仅临时 mock 工作空间／隔离 userData，没有真实模型任务、系统安装或远程发布。

| 命令／检查 | 实际结果 | 证据文件 |
| --- | --- | --- |
| `npm run typecheck` | exit 0，完整类型检查通过 | `01-typecheck.log` |
| `npm run desktop:build:shell` | exit 0，从当前源码重建 | `02-build-shell.log` |
| vitest：workspace-service-info、desktop、probe-contract、shell-contract、service、client-timeout、mcp、service-restart、no-business-roles | **9 文件、100/100 PASS**，exit 0 | `03-focused.log` |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts` | **6/6 PASS**，exit 0，24.5s | `04-shell-e2e.log` |
| 独立真实服务边界脚本 | exit 0，十项检查全部 true；覆盖并发成功／失败、崩溃恢复、死亡 child 清理和实际 Schema | `05-boundaries.json/.stderr`、`revalidate-supervisor.mjs` |
| `npm run desktop:package:shell` | exit 0，独立重建 Linux dir 产物 | `06-package-shell.log` |
| 独立打包窗口／RPC／固定 runtime／退出回收检查 | exit 0，Schema、固定 Node、renderer 隔离和退出回收均通过 | `07-packaged-shell.json/.log/.png`、`packaged-shell-review.mjs` |

本轮没有重跑 `npm ci` 或全量 `npm run check`；开发方 46 文件／493 测试全绿属于开发证据，未充作验收方独立重跑。所选专项覆盖本次改动依赖链与原边界反例；没有跳过项计入通过。

## 5. 范围与后续边界

- 本次 PASS 是 mock 服务的桌面外壳、单 writer、有限 IPC、服务生命周期与运行信息契约验收；不表示完整 GUI 或真实 Harness 产品闭环已交付。
- 真实接入配置／角色库属 G2，原 ZCode 桌面会话的确认—Agent 显式锚定属 G3，完整安装／升级／卸载属 G7。原生目录真实点选仍未在本轮采集，路径自动化使用文档化 fixture。
- G0 曾记录的打包探针首跑超时 N1 保留为历史观察项；本次 shell 打包正常不作为该次超时根因已定位的证据。
- 契约顶部／§2.1“全部未实施”等旧总述仍宜在后续文档维护中与已明确标注的 workspace.info 实现状态统一；§1、§2.3、代码与本轮证据已明确当前交付，不构成剩余功能缺口。

## 6. 最终裁定

**G1 PASS，G1-R01–R04 全部关闭。**G0 PASS 维持，可以按既定计划进入 `prompts/06G2-workspaces-and-roles.md`。本轮停止于独立验收报告，不自动实施 G2，也不授予合并或发布权限。
