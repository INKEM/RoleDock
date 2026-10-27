# P6-G2 独立验收：工作空间、接入预检、角色与策略

> 最新独立裁定见 [P6-G2-final-review.md](P6-G2-final-review.md)：**PASS**，R01–R06 均已关闭。下文及 [返工复验](P6-G2-rework-review.md) 保留各自历史 REWORK 结果。

日期：2026-10-26。结论：**REWORK**。基本启动、预检、策略权限与常规测试通过；仍有六项必需返工，涉及工作空间串接、真实配置重启退回 mock、打包连接器路径、最近记录持久化、配置文件覆盖与角色详情正文。不得进入 G3。

## 1. 范围与基线

依据 AGENTS、开发蓝图、toolchain、桌面计划 §3/§5/§10、ADR-0013、GUI 契约 v4、`prompts/COMMON.md`、`prompts/REVIEW.md`、`prompts/06G2-workspaces-and-roles.md`。被验收报告：[P6-G2-development.md](P6-G2-development.md)。前置 [G0 PASS](P6-G0-final-review.md)、[G1 PASS](P6-G1-final-review.md) 成立；它们是当时范围和基线的历史裁定，不替代本轮 G2 增量验收。

实际基线：HEAD `d9743365256459a773a5319791cf3b7bb2e5fbe7` + 当前 G0/G1/G2 未提交工作区。源码、Schema、测试、构建脚本、契约、锁文件与开发报告共 **127 文件**，验收前后哈希一致，见 [基线核对](evidence/2026-10-26-p6-g2-independent/baseline-verification.json)。本轮未修改产品、契约或开发报告，没有提交、合并或发布。

## 2. 条件对照

| G2 条件 | 独立结果 | 裁定 |
| --- | --- | --- |
| 从 GUI 打开目录，最近记录移除不删除项目 | 可打开且记录；移除后磁盘设置与页面仍含该项，目录保持存在 | **R04** |
| 工作空间身份校验、两个目录不串数据 | A 的连接文件指向 B 时照常附着 B，经 A 界面安装的角色写入 B | **R01** |
| 真实 ZCode launcher 与配置 | 开发版 adapter=zcode 启动成功，零模型轮；点击重启退为 mock；打包版真实分支无法加载连接器 | **R02/R03** |
| 配置只存引用且不破坏用户文件 | 当前配置为路径／标识，未存凭据；但写入跟随符号链接清空目标内容并改变权限 | **R05** |
| 只读预检、独立连接测试 | Node/CLI/connector/bwrap/userns/目录/egress 预检可运行；开发版握手无需模型；打包版把不可供 Node 加载的 ASAR 路径报为连接器就绪 | 开发路径通过，**R03** |
| 任意角色包、职责／模板／输出 Schema 详情 | custom-role 可安装，角色包哈希／主指针／需求与策略可查询；职责是路径，模板／输出 Schema 只有名字／路径 | **R06** |
| 安装不 grant，initialized 不等于可服务；选择角色不创建会话 | 专项与真实窗口回归通过，界面明确区分，未发现具体角色进入核心 | 已验证路径通过 |
| grant/revoke 回读，撤销后下一角色动作拒绝 | GUI 对照与回读通过；另用 Mock 会话夹具经真实服务补验，撤销后 documents.list 返回 PERMISSION_DENIED | **通过本地 Mock 边界** |
| 失败／冲突／受限依赖显示 | 预检单测及 G1 回归覆盖部分路径；真实受管服务启动、完整 helper／模型可用性未在本轮验证 | 如实保留未验证范围，不算成功证据 |

## 3. 必须返工

### G2-R01 — [P1] 未核对目录与服务身份，选择 A 可以操作 B

**位置**：`packages/desktop/src/shell/supervisor.ts:101–108`、`main/workspace-controller.ts:44–66`。

**触发**：在本次验收临时目录中先创建工作空间 A 并记录其 workspace_id；停止 A 后，让 A 的 owner-connection 文件保存工作空间 B 的有效连接。以 GUI 打开 A，随后经同一 GUI 安装 custom-role。

**实际结果**：目录仍显示 A，运行中的 workspace_id 却为 B。原 A 为 `ws-43e86732`，实际附着 `ws-c2ba3e37`；B 原角色数为 0，经过 A 界面安装后 B 出现 archivist。探活成功只证明 token 可连接，当前代码没有与选定目录的持久身份核对。见 [06-gui-repro.json](evidence/2026-10-26-p6-g2-independent/06-gui-repro.json) 的 identity 节。

**影响**：陈旧、复制或放错的连接文件会把后续角色／策略操作发往另一工作空间，违反 G2“身份校验、两个工作空间不会串数据”。本反例只使用验收自建的 A/B 及其凭据，没有访问其他项目。

**修复要求**：在附着和后续操作前建立可信的目录—workspace_id—端点对应关系；不匹配时显示冲突并停止写操作。校验不能依赖渲染器自报 ID，也不能为核对去争抢正在使用的 SQLite writer；不要覆盖未知端点来“恢复”。

**复验**：互换 A/B 连接文件、指向其他目录、恢复陈旧文件时拒绝串接；正确附着、重启后 ID 稳定，正常 A/B 切换下安装／策略只作用于选定工作空间。

### G2-R02 — [P2] 重启真实服务丢失 launcher 配置并退回 mock

**位置**：`packages/desktop/src/shell/supervisor.ts:218–222`；`main/workspace-controller.ts` 的 open/restart；工作空间配置持久化路径。

**触发与结果**：通过设置页配置本机 ZCode CLI，使用 zcode 模式打开 A，诊断确认 adapter=zcode；点击“重启服务”后，同 workspace_id 的 adapter 变为 mock，状态卡模式也为 mock，磁盘 launcher-config.json 的 kind 却仍为 zcode。见 `06-gui-repro.json` 的 restart 节。

**原因与影响**：restart 停止服务后调用 `open(dir)`，没有传回真实 launcher；缺省分支使用 `--mock-workspace`。真实配置没有进入可恢复的工作空间生命周期，重启会改变后端语义。

**修复要求**：保存并恢复每工作空间的实际启动配置／引用；重启、崩溃重开、最近记录重开和 UI 重启应保持所选模式与配置。全局默认设置不能无提示替换已有工作空间配置。配置失效须明确失败，不自动改用 mock。

**复验**：真实配置启动→restart、SIGKILL→重开、退出后从最近记录重开，adapter／模式和 provider/model/managed 引用均保持；A/B 不串配置。仅需要零模型的连接与服务底座实证，不要求提前完成 G3 锚定。

### G2-R03 — [P2] 打包版连接器指向 ASAR，独立 Node 无法加载

**位置**：`packages/desktop/src/shell/main/index.ts:53–54`；`scripts/build-shell.mjs`、`electron-builder.shell.yml` 的资源布局。

**触发与结果**：从当前源码独立重建 dir 产物，先验证 mock 正常 running；再设置同一本机 CLI，以 zcode 模式运行连接测试和打开工作空间。预检报告 connector_bundle=ok，但 testConnection 返回 NOT_IMPLEMENTED，服务启动为 disconnected。

配置中的 connectorPath 是 `resources/app.asar/dist-desktop/vendor/zcode-connector.mjs`。使用随包 Node `--check` 此路径 exit 1 / MODULE_NOT_FOUND；包外实际资源 `resources/runtime/vendor/zcode-connector.mjs` 则 exit 0。见 [08-packaged.json](evidence/2026-10-26-p6-g2-independent/08-packaged.json)、[10-connector-path.json](evidence/2026-10-26-p6-g2-independent/10-connector-path.json)。

**影响**：开发版成功不能延伸为打包后真实配置可用；Electron 的文件存在检查能看见 ASAR 内部，而独立 Node 无法按同一路径加载它。既有打包冒烟只打开 mock，遗漏该分支。

**修复要求**：像 service-bundle 一样分别解析开发／打包连接器资源路径；main/controller/preflight/testConnection 使用一致的、可由固定 Node 实际读取的入口。预检不能仅以 Electron existsSync 当作 Node 可启动证明。

**复验**：最新 dir 产物在无源码依赖的工作目录启动，GUI 配置→预检→握手→adapter=zcode→退出回收全链通过；mock 对照仍通过。此项不要求 deb 系统安装或模型调用。

### G2-R04 — [P2] 移除最近工作空间没有持久化

**位置**：`packages/desktop/src/shell/main/ipc.ts:71–74`、`renderer/pages/workspace.ts` 的 remove-recent 处理。

**触发与结果**：打开 A 后点击“移除记录”，handler 返回移除后的临时数组，却未调用 saveSettingsFile；页面随即从 settings.get 重读，A 仍在列表。实际磁盘／设置回读仍含 A。见 `06-gui-repro.json` 的 recent 节。

**影响**：移除动作没有实现，应用重启也仍保留记录。原 E2E 只断言本次 removeRecent 的返回值与目录仍在，未验证重新读取。

**修复要求**：将移除后的设置写回，再回读；只删最近记录，不动项目、服务、角色或其他设置。

**复验**：真实点击后立即重新查询、重新进入页面及重新启动应用均不再显示该项；实际目录、数据和其他最近记录保持完整。

### G2-R05 — [P1] launcher 配置写入跟随符号链接，覆盖已有文件

**位置**：`packages/desktop/src/shell/shared/launcher.ts:17–24`；controller.open 在附着／身份校验前调用该函数。

**触发与结果**：在验收临时工作空间中令 `.roledock/launcher-config.json` 链接到同一临时目录中的 existing-notes.txt，原内容为合成哨兵。调用配置写入后目标被替换为 launcher JSON，权限从 0644 改为 0600。见 [05-config-file.json](evidence/2026-10-26-p6-g2-independent/05-config-file.json)，targetPreserved=false。未触碰任何真实用户文件。

**影响**：打开／配置已有目录可能清空配置路径所引用的其他文件。当前 O_TRUNC 写入与 fchmod 都在缺少类型／归属校验的情况下跟随链接。

**修复要求**：写前验证状态目录及配置文件的类型／属主，拒绝无法证明安全的链接或其他端点；使用不跟随链接且避免检查到写入竞态的文件操作，保留原内容直到新配置完整落盘。不要通过递归清空 `.roledock` 解决冲突。

**复验**：常规首次写入／更新成功；配置文件链接、状态目录链接和不合法端点被拒绝；链接目标的内容、权限及其他工作空间文件完全不变。

### G2-R06 — [P2] 职责、模板与输出 Schema 详情仍是路径／名称

**位置**：`packages/core/src/admin.ts:102–121`、`packages/protocol/schemas/role-details.schema.json`、`packages/desktop/src/shell/renderer/pages/roles.ts:56–62`。

**触发与结果**：安装标准 demo-team，打开 reviewer 详情，实际显示“职责：roles/reviewer.md”、“文档模板：reviews（project）”、“输出 Schema：review-result”。RPC instructions 也只是路径；documents 未返回模板内容，output_schemas.schema 是文件路径，页面只取 key。见 `06-gui-repro.json` 的 roleDetails 节，附模板原文与 Schema 对照。

**影响**：用户仍无法在 GUI 了解实际角色职责、模板结构或输出约束。测试 `instructions.length>0` 让一个文件路径也被计作职责正文已交付。

**修复要求**：经可信服务读取已安装且版本固定的角色材料，返回可阅读的职责正文、模板和有实际约束含义的 Schema 摘要／详情；不让 renderer 打开任意文件路径，不执行包脚本或 HTML。扩展 Schema／类型并在服务边界验证后再展示。只读即可，不要求实现编辑器。

**复验**：任意不同角色包的真实内容可在 GUI 展示，与安装快照／哈希对应；替换来源目录不静默改变已安装视图；无效包、重复安装、内容冲突与含特殊字符内容都正确处理；选择详情仍不创建会话、安装仍不 grant。

## 4. 独立运行与证据

统一目录：[2026-10-26-p6-g2-independent](evidence/2026-10-26-p6-g2-independent/)。Node 22.23.2 / npm 10.9.8；本机 CLI 只读版本查询返回 **0.17.0**，不将 toolchain 历史记录 0.16.9 当作当前实测。bwrap 0.6.1 的干跑通过。

Unix socket、Electron 和本机 ZCode 分支均经本地自动审批运行。真实宿主分支只做版本查询／连接器握手／服务配置启动，零真实会话、零模型轮。策略动作补验使用纯 Mock 绑定夹具，不能作为真实 Harness 锚定证据。

| 命令／检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `01-typecheck.log` |
| `npm run desktop:build:shell` | exit 0 | `02-build-shell.log` |
| vitest：新增 G2 读模型／预检、desktop/protocol/service/MCP/服务重启/无业务角色专项 | **12 文件、113/113 PASS**，exit 0 | `03-focused.log` |
| shell 真实 Electron E2E（G1+G2） | **8/8 PASS**，exit 0，51.7s；本机实际进入 CLI 存在分支 | `04-shell-e2e.log` |
| 配置文件链接反例 | 复现脚本 exit 0；目标内容／权限被改写，不符合要求 | `05-config-file.json`、`repro-storage.mjs` |
| 独立 GUI 扩展路径 | 脚本 exit 0；复现身份串接、重启退回 mock、最近记录未移除、角色正文缺失 | `06-gui-repro.json/.stderr`、`repro-gui.mjs` |
| `npm run desktop:package:shell` | exit 0，重建 Linux dir 产物 | `07-package-shell.log` |
| 新打包产物 mock／zcode 对照 | mock running；真实分支握手失败、服务 disconnected；复现脚本 exit 0 表示已完成取证，不代表真实启动通过 | `08-packaged.json/.stderr/.png`、`repro-packaged.mjs` |
| 固定 Node 对连接器两路径的 `--check` | ASAR 路径 exit 1，包外 runtime/vendor 路径 exit 0 | `10-connector-path.json` |
| 核心策略专项 | **1 文件、5/5 PASS**，exit 0 | `09-core-policy.log` |
| 独立 Mock 策略撤销后下一角色动作 | 撤销前 documents.list 成功；owner revoke 后同一绑定下一次读取 PERMISSION_DENIED，exit 0 | `11-policy-action.json/.stderr`、`check-policy-action.mjs` |

独立正式测试合计 **118 项**，另有 **8 项 Electron E2E**；反例取证单列，不算通过的产品行为。本轮未运行 `npm ci` 或全量 `npm run check`；开发方 49 文件／506 测试及重跑日志只作开发证据，未充作验收方重跑。没有修改实现来掩盖失败。

## 5. 限制与未验收内容

- 原生目录真实点选回传仍未在本轮采集，自动化路径选择使用文档化 fixture。现有 E2E 的角色安装／策略主断言通过 IPC，不能全部写成按钮点击已经验收。
- managed sandbox 的真实服务执行、完整 helper／模型可用性、原 ZCode 桌面会话和人类确认／Agent 锚定链未在本轮运行，不将普通握手或 runner 干跑当作它们的成功证据。G3/G7 保留既定真实闭环要求；受管状态的声明与实际验证必须继续区分。
- 人类事件 source 由现有 ExternalSessionAuthority 构造时注入 adapter；本轮源码核对了该接线，未把 bin 中未直接传 source 误报为缺失。
- `roles.get`／`policy.list` 当前走 admin 直接返回，新增 Schema 的运行时应用应随 R06 一并落实；仅注册 Schema 与测试样例不等于所有 RPC 都在边界验证。

## 6. 结论与下一步

**G2 REWORK**。先修 G2-R01–R06，更新开发报告与新基线，独立复验真实配置的生命周期／打包、身份绑定、文件保护和实际角色材料展示。已通过的策略权限边界、安装不 grant、单 writer、有限 IPC 与零模型预检能力可保留。未通过前不进入 G3，不自动提交、合并或发布。
