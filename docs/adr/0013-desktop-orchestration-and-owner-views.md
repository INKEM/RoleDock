# ADR-0013：桌面编排层与所有者视图规划

日期：2026-10-25

状态：**候选定档（开发方，2026-10-25）；待独立验收**。2026-10-26 首轮独立验收为 **REWORK**（R01–R04，见 [P6-G0-review.md](../phase-reports/P6-G0-review.md)）；返工后须经独立复验 PASS，本文才可标记为验收通过，此前不得作为"G0 已通过"依据进入 G1。沿用 ADR-0007/0009/0011/0012 的身份、授权和执行边界，不重新授予角色发布权。定档结果见文末「P6-G0 定档结果」。

关联：[桌面 GUI 分阶段计划](../DESKTOP_GUI_PLAN.md)、[P5-H 收口验收](../phase-reports/P5-H-b5-4-review.md)。

## 背景

P5-A 已交付单协调器服务和会话 MCP 工具，G-min 已交付受信授权确认页。P5-H B5-4 独立验收通过，真实请求链与受管执行边界已具备基础证据。但当前 desktop 入口仍需已运行的服务及 owner 连接文件，service 命令行仅提供 mock 启动。现有所有者 RPC 无完整的绑定／尝试／知识／请求详情视图。

把现有 G-min 页面包进桌面窗口无法解决工作空间启动、现有 ZCode 桌面会话接入、查询完整性与角色动作归属问题。

## 提议

1. **桌面只管理，不自建聊天 Harness。** `packages/desktop` 承担窗口、设置、受限 IPC 和生命周期编排；core 不导入 UI 或宿主 SDK。优先验证 Electron 外壳与独立 Node 22.23.2 工作空间服务子进程，确切技术和版本在 P6-G0 定档。不得默认使用外壳内置 Node 替代已锁定的 SQLite 运行时。
2. **每工作空间仍只有一个 writer。** 桌面负责发现／附着或启动服务。已运行但不能证明归属的服务只显示连接冲突，不抢锁、不覆盖端点。窗口关闭与停止服务分开，默认关闭窗口不撤销外部角色。应用退出遵守当前工作空间的显式后台／停机策略，只回收自己拥有的进程。
3. **先补明确的所有者查询，不转借会话身份。** 在 service 控制面定义分页、脱敏的读模型，展示授权、绑定、锚定尝试、知识、请求、产物和回收状态。所有者读取范围由 P6-G0 明确，至少不得读取宿主原始私人聊天或凭据；不从渲染器指定 session_id 冒充某角色。
4. **人类事件、授权、绑定分开展示。** 保持 `submitHumanEvent → trusted recordHuman → Agent sessions.anchor → load confirmation → CAS` 的实际链。GUI 确认只代表事件已存储；默认接入器自动推进受信事件登记，显式锚定仍由原会话 Agent 发起。没有可验证的直接人类消息通道时，GUI 确认是必要受信入口，不能被模型文字代替。
5. **角色写入仍走原角色连接。** GUI 可管理策略、授权、导入候选和本地草稿；正式文档发布、请求回复、结果采纳仍由当前有权角色经会话面完成。若增加所有者候选提议或管理取消，须有独立操作、明确 owner 来源、审计及状态约束，不能调用内部函数伪造角色身份。
6. **现有桌面主会话与受管请求执行区分能力。** P6-G3 必须验证真正由用户在 ZCode 桌面打开的原会话。若需要不同的接入通道来处理主会话身份／载入和 consultation 受管执行，在 adapter/launcher 层按明确归属路由，先修订适配契约；不得让非受管通道继承 full 隔离声明，不在 core 硬编码 ZCode。
7. **新视图首版采用有界查询。** 服务尚无通用状态订阅协议；首版使用轮询、快照时间、版本和分页，刷新仅查询。以后若需要事件流，另行定义序号、断点补偿和失效规则，不将 outbox 诊断列表伪装成完整事件总线。

## 预期代价与退出条件

需要 desktop launcher、受信接入器的运行配置与恢复、新的 owner 读模型及少量明确控制操作、UI 渲染隔离、浏览器／桌面自动化与 Linux 打包。新增包与 Schema 只在相应子阶段实现。

P6-G0 应交付可运行技术探针、操作契约表、数据可见性决策与 ADR 最终状态；独立验收通过后进入 G1。本提案不修改现有授权和发布守卫，也不表示完整桌面 GUI 已交付。

## P6-G0 定档结果（2026-10-25）

本节为上述提议的 G0 落地结论；细节以 [desktop-gui-contract](../spec/desktop-gui-contract.md) 与 [toolchain](../toolchain.md)「P6-G0 桌面技术定档」为准，证据见 `phase-reports/evidence/2026-10-25-p6-g0/`。

1. **技术栈定档**：Electron 44.9.3（外壳 Node 24.22.0 ≠ 锁定 22.23.2，仅作 shell 与编排）+ 无框架 TypeScript 渲染层 + esbuild 0.28.2 唯一构建器 + @playwright/test 1.64.1 E2E + electron-builder 26.18.0 打包。服务子进程强制使用官方 dist Node 22.23.2（SHA256 校验，打包为 `resources/runtime/node`）；`node:sqlite` 始终运行在锁定 runtime。Tauri 备选未启用（Electron 探针一次通过，无需备选比较）。
2. **探针实测结论**：真实窗口 + 具名 IPC（封闭清单、无任意 RPC、渲染层无凭据/无 Node）+ 目录选择（原生对话框经 X11 窗口树证实存在；人手点选留验收复现）+ Node 22.23.2 服务子进程启停 + SQLite 单 writer（第二连接 errcode=5）+ MCP 子进程握手（14 工具 + `authorizations.get`）+ 打包后运行时定位（`--selfcheck` 与窗口模式均 `mode=packaged` PASS）。生命周期实测：关窗保留服务、退出回收自有子进程、单实例锁拒二次启动、停止后锁释放可重开。
3. **owner 读模型契约**：16 项操作名/输入输出/分页/脱敏定档于契约文档 §2（`workspace.info` 扩展、`roles.get`、`policy.list`、`authorizations.confirmations|revokePreview`、`sessions.listBindings|listAttempts|listLoads`、`documents.list|read|listCandidates`、`proposals.submit`、`requests.listInbox|get|cancelByOwner`、session 侧 `inbox.list`）；均未实施，实现子阶段先补 Schema。
4. **可见性与幂等决策**：请求 payload 正文对 owner 可见（凭据形态字段脱敏，用户确认）；private/role 文档正文对 owner 仅元数据+哈希；宿主原始私人聊天与一切凭据不可见。新增写操作采用可选 `idempotency_key`（首次结果存储、重放标注、冲突报错），现有 18 操作不改语义。
5. **安装格式**：只维护 `.deb` 一个首发安装格式（G7 出包验收）；解压即跑 `dir` 为开发产物。deb 打包可行性已实测（含 scope 目录需预创建、homepage 元数据两处怪癖）。

## 定档修订历史

- 2026-10-25：开发方首轮定档（本文件「P6-G0 定档结果」与 [desktop-gui-contract](../spec/desktop-gui-contract.md) v1）。
- 2026-10-26：首轮独立验收 **REWORK**（R01 脱敏误删业务标识且文本脱敏未兑现、R02 管理取消状态名不符协议、R03 页面必需查询映射不全、R04 本 ADR 提前宣称验收通过）。技术选型（Electron/独立 Node/SQLite/MCP/打包链）经验收方独立复现，**未被否定**。契约文档已修订至 v2（脱敏四层定义、取消逐状态矩阵、页面动作→操作映射 + `workspace.runtimeStatus`/`documents.listRevisions`/`checkpoints.list`/`artifacts.read`(owner)/`requests.listCleanup` 等补充），本 ADR 状态改回待独立验收。复验 PASS 前维持该状态。
