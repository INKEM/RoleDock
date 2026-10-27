# P6-G1 开发报告：桌面外壳与服务生命周期

日期：2026-10-26。**状态：待独立验收。**

## 0. 前置偏差（如实记录）

G1 提示词前置为"P6-G0 独立验收 PASS"。当前状态：G0 首轮独立验收 **REWORK**（`P6-G0-review.md`，2026-10-26）；R01–R04 返工已完成且回归全绿（`P6-G0-development.md` §9），但**复验报告尚未出具**。按用户明确指示开工本阶段，此偏差由验收方裁定。技术风险已尽量压低：G0 探针（`src/probe/**`）、`scripts/build.mjs`、`electron-builder.yml` 全程冻结未动，G0 复验可随时独立重跑。

## 1. 实际基线

- HEAD：`d9743365256459a773a5319791cf3b7bb2e5fbe7`；工作区为 G0+返工与本阶段全部未提交改动（见证据 `01-baseline.txt`）。
- 前序：P5 整体 PASS、G-min PASS；桌面计划 §4/§9、ADR-0013、G0 契约（`docs/spec/desktop-gui-contract.md`）为设计输入。

## 2. 交付与验收条件对照（提示词 `prompts/06G1-shell-and-runtime.md`）

| 提示词要求 | 交付 | 结论 |
| --- | --- | --- |
| main/preload/renderer/runtime 边界、模块化 G-min、导航壳、统一错误、具名 IPC；不新建 core | `src/shell/`（main/preload/renderer/shared/runtime/supervisor）；G-min 决策逻辑提取 `src/gmin/confirm.ts`（http 入口行为不变，3 项既有测试回归通过）；hash 导航壳 + 全局错误边界 + 封闭清单具名 IPC | 完成 |
| 工作空间 supervisor、发现/附着/启动、重复启动处理、后台/退出策略、重连；只管自有进程 | `supervisor.ts` + `workspace-controller.ts`：附着/启动/冲突/崩溃检测/有界停机/退出回收；单实例锁聚焦原窗口；附着的外部服务绝不停止（E2E 场景 2） | 完成 |
| 独立锁定 Node；owner 凭据在受信层；渲染层无写库/Shell/通用 RPC/bearer；G-min 诊断入口边界 | 服务子进程=官方 dist Node 22.23.2（结构化参数、最小 env、无 shell）；凭据仅在 main；renderer 无 `process`/`require`、无 64-hex token（E2E 断言）；G-min loopback 入口保留为诊断入口，边界写入契约 §4（只代理 3 操作） | 完成 |
| ServiceClient 请求等待期限 + 有界停机；两窗口一 writer、关窗不撤权、重启附着、异常端点拒绝、服务退出清理、未授权 IPC 拒绝 | `call(op,input,{timeoutMs})` 默认 30s + `ServiceRequestTimeoutError`（黑洞 socket 单测）；SIGTERM→8s→SIGKILL，超时保留持久状态待对账；§4 验证清单 8 场景 E2E 全过（`04-shell-e2e.log`） | 完成 |
| 退出：从桌面入口开窗口并启动/附着 mock 服务，无需手输 owner 文件；单 writer 与恢复证据齐全；不做真实接入与其余页面 | E2E 场景 1（对话框选空目录→服务 running）+ 打包冒烟（打包产物打开空工作空间）；只两页半（工作空间/确认/设置），无真实接入 | 满足 |

## 3. 主要文件与公共接口变化

新增（shell，`packages/desktop/`）：

- `src/shell/shared/`：`contract.ts`（`SHELL_NAMESPACES` 封闭清单 + `createShellApi` + `WorkspaceStatus` 类型）、`redact.ts`（shell 自有副本，与探针同规则）、`sender.ts`（`isTrustedSender`/`shellPageUrlPrefix`，纯函数）、`settings.ts`（`settings.json` 读写，默认值/合并/容错）。
- `src/shell/runtime.ts`（锁定 Node 解析，env `ROLEDOCK_SHELL_NODE`）；`src/shell/supervisor.ts`（附着/启动/有界停机/崩溃检测/`reapOwned`；就绪=凭据真实探活，防陈旧 owner 文件竞态）。
- `src/shell/main/`：`index.ts`（稳定 userData、单实例锁、退出策略：默认回收 owned、附着外部服务绝不杀）、`ipc.ts`（封闭清单 handler + 发送方校验 + redact + 无参方法拒收 payload）、`workspace-controller.ts`（前台工作空间编排；confirm/诊断的 owner RPC 中转）。
- `src/shell/preload.ts`（`window.roledock.shell.{workspace,confirm,settings,app}`）；`renderer/`（`main.ts` 路由+错误边界、`pages/workspace.ts`（含 2s 状态轮询）、`pages/confirm.ts`（G-min 生产页）、`pages/settings.ts`）。
- `scripts/build-shell.mjs`、`scripts/shell.mjs`、`scripts/packaged-shell-evidence.mjs`、`electron-builder.shell.yml`（`extraMetadata.main` 覆盖，不动探针配置）、`playwright.shell.config.ts`。
- 测试：`test/shell-contract.test.ts`（清单封闭/redact 分层/发送方校验/settings/运行时解析 7 项）、`test/e2e-shell/shell.e2e.spec.ts`（4 场景）、`packages/service/test/client-timeout.test.ts`（3 项）。

修改：

- `packages/service/src/index.ts`：`ServiceClient.call` 增加 `{ timeoutMs }`（默认 30s）与 `ServiceRequestTimeoutError`（本地错误，不入协议错误码注册表）。**共享包唯一行为变更**，默认期限与既有服务端 30s 超时兼容。
- `packages/desktop/src/index.ts` + 新 `src/gmin/confirm.ts`：G-min 模块化提取，http 诊断入口行为不变。
- 根 `package.json`：`desktop:build:shell / desktop:shell / desktop:e2e:shell / desktop:package:shell`；`.gitignore`：`dist-app-shell/`。
- 文档：契约 §4（shell 接口清单 + 诊断入口边界）、§7（生命周期 G1 定档）；toolchain「P6-G1 桌面外壳增量」。

冻结未动：`src/probe/**`、`scripts/build.mjs`、`electron-builder.yml`、core/protocol/adapters。

## 4. 验证（真实运行；证据 `evidence/2026-10-26-p6-g1/`）

| 命令 | 结果 |
| --- | --- |
| `npm run build` + `node scripts/build-shell.mjs` | exit 0，shell bundle 产出 |
| `npx vitest run shell-contract + client-timeout + desktop.test` | 13/13 PASS（`03-unit.log`） |
| `npx playwright test --config playwright.shell.config.ts` | **4 场景全过（25.7s，`04-shell-e2e.log`）**：①空工作空间对话框启动、封闭清单、渲染层无 Node/凭据 ②应用内双窗口同 writer 同 pid + 外部第二连接 SQLITE_BUSY ③外部附着服务跨两次 UI 重启存活、退出应用不杀 ④宽松权限/非 socket 假端点冲突拒绝且文件未被改写、SIGKILL 崩溃→断线显示→UI 重启恢复同 workspace_id ⑤未授权 IPC（未知方法 undefined、无参方法拒收 payload、命名空间封闭） |
| `npx electron-builder --config electron-builder.shell.yml --publish never` | exit 0（`06-packaging.txt`） |
| `node scripts/packaged-shell-evidence.mjs …`（打包产物） | 空工作空间打开→running（`05-packaged-shell.json/.png`） |
| `npm run check` | **exit 0：45 文件 / 487 测试全绿**（`07-check.log`；含既有全部套件 + G-min 回归） |

## 5. 失败、跳过与未验证项

1. **前置偏差**（§0）：G0 复验未出即开工，由验收裁定。
2. **deb 未出**：G1 只做 dir 解压即跑产物；安装包验收按计划留 G7。
3. **真实点选对话框未自动化**：沿用 G0 结论（xdotool 缺失）；E2E 用文档化的 `ROLEDOCK_SHELL_DIALOG_FIXTURE`，真实对话框已在 G0 以 X11 窗口树取证。
4. **附着的外部服务非本应用启动的 PID 未知**：状态卡对外部服务显示 `pid：—`（owner 面无进程查询 RPC，属协议现状，非缺口）。
5. **托盘/后台常驻**：按计划 §4.3 未采用（须实测后才可引入），退出策略=停 owned 服务；"退出不停服务"开关已留（`exitStopsOwnedServices`）。
6. 服务崩溃自动重启未做（UI 手动重启）；自动重连/重试策略按计划 §4.3 属后续页面性能目标（G4）。

## 6. 规范/ADR 更新与影响

- 契约 §4/§7：shell 具名接口清单、发送方校验、诊断入口边界、生命周期 G1 定档（关窗保留/退出停 owned/有界停机语义/就绪探活/单实例/切换）。
- toolchain：ServiceClient 超时（共享包行为变更）、shell 构建命令与测试钩子 env。
- 无新 ADR：本阶段架构在 ADR-0013 与 G0 契约框架内，无权限模型变化。

## 7. 下一阶段可用输入与遗留

- 可用输入：shell 骨架与 supervisor（G2 工作空间/接入预检/角色库直接扩展 workspace 页与 owner 读模型 RPC）、`workspace.runtimeStatus`（G2）、G-min 生产确认页（G3 接真实会话）。
- 遗留（属后续阶段）：真实接入预检、`runtimeStatus`、真实 ZCode 会话、轮询性能调优、deb/安装验证、托盘评估。

## 8. 停止点声明

本报告完成后停止：未 `git commit`、未进入 G2、不做真实接入与其余页面、无远程发布。请独立验收 Agent 按 `prompts/REVIEW.md` 形成 `P6-G1-review.md`。

## 9. 验收返工说明（2026-10-26，按 P6-G1-review.md G1-R01–R04）

首轮验收 **REWORK**。四项全部修复（G0 复验剩余项见 `P6-G0-development.md` §10）：

### G1-R01 — 附着保存凭据，owner 功能与健康刷新可用

- `supervisor.open` 附着成功分支现把**已验证的 owner 凭据**存入 handle（仅受信 main 进程持有，不进 renderer、不停止外部服务）；`ownerClient()`/诊断/确认页由此可用。
- `refresh()` 对附着句柄以存凭据真实探活：更新 `lastRefreshAt`/`workspaceId`/`pid`；端点死亡 → `disconnected` 并显示原因（修复"无凭据提前返回导致永远 running"）。
- E2E 场景 2 扩展：附着后经实际 IPC 执行 `diagnostics`（含 workspace_id、adapter=mock）与 `confirm.listRoles`（ok=true）；SIGKILL 外部服务后 `#refresh` → 卡片 disconnected。

### G1-R02 — 重开自有工作空间保持归属；路径归一化与并发去重

- `open()`：目录存在**存活 owned 子进程**的原句柄时**原样返回**（owned/pid/child 不变）；仅真正外部服务生成 attached 句柄。
- 目录键统一 `realpathSync` 归一化（路径别名不再分叉句柄）；同目录并发 open 共享单个 in-flight Promise；`stop/restart` 先等待该目录 in-flight 打开，不再以"停所有端点"代替归属判断。
- E2E 场景 1 扩展：A→A 重开后卡片仍为原 pid、"本应用启动"；退出回收照常。

### G1-R03 — 无窗口时再次启动恢复 shell UI

- `second-instance`：窗口数为 0 时**重建受限 shell 窗口**（复用原 controller/supervisor，不启动第二 writer）；有窗口时保持聚焦逻辑。
- 新增 E2E 场景 5：起服务→关全部窗口→再次启动→第二实例退出并输出 refused、原实例窗口数 0→1→恢复窗口显示同一 workspace_id/pid→诊断可用→显式退出回收 owned 服务。

### G1-R04 — workspace.info 扩展交付

- 协议新增 `WorkspaceServiceInfo` 类型（`packages/protocol/src/types.ts`）；service `workspace.info` 返回 `workspace_id + service{version,pid,started_at,adapter,runtime}`——**只暴露非敏感运行信息**（无 argv/路径/凭据；adapter 取自 `getCapabilities().adapter`）。
- shell 诊断面板展示 version/adapter/runtime/pid/started_at；附着服务的状态卡 pid 来自真实 RPC（不再显示"—"）。契约 §2.3 该行标注"**G1 已实现**"；开发报告 §5 第 4 项"pid 未知属协议现状"的说法作废（当时与定档契约的差异已在本次交付消除）。

### 回归与证据

`probe-contract/shell-contract/client-timeout` 单测、shell E2E **5 场景**、探针 E2E、`npm run check` 全绿；证据 `evidence/2026-10-26-p6-g01-rework/`。状态保持**待独立验收（返工完成，再次提请复验）**。

## 10. 复验返工说明 v2（2026-10-26，按 P6-G1-rework-review.md）

复验裁定：G1-R01、G1-R03 关闭；**G1-R02 部分关闭（信号退出与并发启动边界）、G1-R04 部分关闭（缺协议 Schema）**。本轮修复：

### G1-R02（续）— 统一存活判定与共享 in-flight

- **信号退出误判**（触发 A）：`InternalHandle` 增加 `exited` 标志（child 的 exit 事件置位，权威于 `exitCode`——SIGKILL 后 `exitCode` 保持 null 而 `signalCode` 已设），新增类型守卫 `isAlive()`（exited/exitCode/signalCode 三重判定）。`open` 的快速复用路径现要求 `state==="running" && isAlive`，SIGKILL→disconnected 后**再次 open 同目录**走全新启动：同 workspace_id、新 pid、诊断可用（E2E 场景 3 改为 open 而非 restart 驱动，并断言新 pid ≠ 旧 pid）。
- **并发首次 open**（触发 B）：`#opening` in-flight 检查**前移**到快路径之前——第二个调用者等待同一个就绪/失败 Promise，不再拿到中间态 `starting` 快照。新增 E2E 场景 4：同目录两次并发 `workspace.open` 均在实际就绪后完成，`running`、同 pid、同 workspace_id。
- **已结束 child 不再等待**：`stop/restart/reapOwned` 全部改用 `isAlive` 判定——已被信号结束的 child 直接清理句柄，不再 SIGTERM 并等待一个不会再次发生的 exit 事件（reapOwned 对死亡 owned 句柄直接删除）。
- 归属保留（A→A、A→B→A、realpath 别名）、外部服务不回收、单 writer 约束不变；未引入自动重启后台任务（按复验要求）。

### G1-R04（续）— Schema 权威契约补齐

- 新增 `packages/protocol/schemas/workspace-service-info.schema.json`（`workspace_id` + `service{version,pid≥1,started_at(date-time),adapter(小写标识),runtime}`，`additionalProperties:false`）；`SchemaName` 联合与 `SCHEMA_NAMES` 注册 `workspace-service-info`。
- service 在 `workspace.info` 传输边界以 `validate("workspace-service-info", projection)` 校验后才返回，失败抛 `INTERNAL`（附 ajv 错误）。
- 新增协议测试 `packages/protocol/test/workspace-service-info.test.ts`：合法投影通过；缺字段、`pid=0`/字符串 pid、非法时间、非法 adapter、空 runtime 拒绝；**额外字段（token/argv/socket_path）一律拒绝**（含嵌套 service 层）。
- 契约 §1 旧盘点同步：`workspace.info` 标注"G0 基线仅 workspace_id；G1 已扩展并注册 Schema"，历史基线与当前实现不再混淆。

### 回归与证据

干净构建后：shell E2E **6 场景**（新增并发 open、SIGKILL-open 恢复）、探针 E2E、协议/桌面/服务单测、`npm run check` 全绿；打包冒烟通过。证据 `evidence/2026-10-26-p6-g01-rework/`（`08-shell-e2e-r2.log`、`09-unit-r2.log`、`10-check-r2.log`、`06-packaged-shell.*`）。状态保持**待独立验收（第二次返工完成，再次提请复验）**。
