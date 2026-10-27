# P6-G2 开发报告：工作空间、接入预检、角色与策略

日期：2026-10-26。**状态：待独立验收。**

## 1. 前置与实际基线

- 前置：`P6-G0-final-review.md` **PASS**、`P6-G1-final-review.md` **PASS**（R02/R04 关闭）——本轮无前置偏差。
- HEAD `d9743365` + 未提交工作区（G0/G1/G2 累计改动全部保留，无提交）。基线快照见证据 `01-baseline.txt`。

## 2. 交付与验收条件对照（提示词 `prompts/06G2-workspaces-and-roles.md`）

| 提示词要求 | 交付 | 结论 |
| --- | --- | --- |
| 创建/打开/最近工作空间、目录选择、身份校验、错误恢复；移除记录不删项目 | workspace 页：模式选择（mock/zcode）+ 原生目录选择 + 最近列表（`settings.recentWorkspaces`，移除仅删记录——E2E 断言目录仍在）；冲突/不可写/死亡端点的具体文案与安全启动路径沿用 G1 supervisor | 完成 |
| 真实 ZCode launcher 与接入配置（CLI/连接器/helper 引用/模型标识/受管出口）；不携带个人路径/账户材料 | service bin 新增 `--workspace-config <json> <root>` 模式：connector 握手→`ZCodeAdapter`→`WorkspaceService.start`，退出 `closeJournal`+`disconnect`；配置由 shell 写 `<root>/.roledock/launcher-config.json`（0600），仅路径与标识；helper 输出永不到 renderer | 完成 |
| 预检 Node/CLI/connector/bwrap/userns/目录，只读不消费模型；真实连接测试为单独动作 | `src/shell/preflight.ts` 七项检查（exec 注入可测；bwrap 用适配器包导出的 `probeSandboxRunner` 真实干跑；userns 读 /proc/sys 仅显示）；"运行连接测试"独立按钮=connector 握手 tools/list（零会话零模型轮），显示 server/工具数 | 完成 |
| 角色包安装、职责/模板/输出 Schema 详情、包哈希、主指针、需求/策略对照；安装不自动 grant；initialized ≠ 可服务 | 新 `roles.get`/`policy.list` owner RPC（Schema 先行）+ 角色库页：安装（幂等/冲突如实显示）、列表、详情（职责/模板/输出 Schema/包哈希/generation/current_instance_id，明示"initialized 不等于可服务"）、需求 vs 授予对照、grant/revoke 逐条+回读；选择角色无会话入口（锚定留 G3） | 完成 |

**退出条件**：E2E 实证——GUI 安装 `examples/custom-role`（任意包、无 core 改动）→ 详情对照 → grant→回读→revoke→回读；**真实 ZCode 启动分支在本机实际执行通过**（本机 CLI 存在：service 以 adapter=zcode 启动、诊断显示 `adapter=zcode`、零会话零模型轮；无 CLI 时断言受限显示——分支覆盖见 `04-shell-e2e-g2.log` 场景 2）；缺 helper 时模型动作将由连接器如实失败（本轮不触达，G3 验证）。无依赖时预检如实显示 missing/受限。

## 3. 主要文件与公共接口变化

- **protocol**：新类型 `RoleDetails`/`PolicyEntry`/`PolicyListPage`/`WorkspaceRuntimeStatus`；新 Schema `role-details`/`policy-list`/`workspace-runtime-status` 并注册（`SCHEMA_NAMES`）。
- **core**（唯一改动，只读投影）：`WorkspaceAdmin.roleDetails`/`listPolicy`——无任何授权/发布语义变化。
- **service**：owner 面新操作 `roles.get`/`policy.list`/`workspace.runtimeStatus`（session 面调用一律 `PERMISSION_DENIED`，单测覆盖）；`workspace.info`/`runtimeStatus` 在传输边界按 Schema 校验；bin 新增 `--workspace-config` 模式；`packages/service` 新增工作区依赖 `@roledock/adapter-zcode`（bin 级 launcher）。
- **desktop**：`shell/preflight.ts`（新）；supervisor 支持 launcher 模式（argv `[bundle,"--workspace-config",configPath,dir]`；handle/status 增加 `mode`）；controller/ipc 扩展（`roles` namespace 5 方法、`workspace.preflight/testConnection/removeRecent`、open 带 launcher）；renderer：workspace 页改造（模式选择/最近列表/预检面板/连接测试/2s 状态轮询）、新角色库页、设置页 ZCode 接入配置区；`build-shell.mjs` 增加 `vendor/zcode-connector.mjs`。
- **adapters/zcode**：包入口补只读预检导出（`probeSandboxRunner`/`planEgress`，纯函数，无行为变化）。
- **tests**：`protocol/g2-read-models.test.ts`（3）、`service/g2-read-models.test.ts`（4）、`desktop/preflight.test.ts`（3）、`e2e-shell/g2.e2e.spec.ts`（2 场景）。
- **测试适配**：`tests/integration/service-restart.process.test.ts` 就绪标记从 "Mock RoleDock service:" 改为适配器无关的 "RoleDock service ("，并断言重启后 `service.pid/started_at` 指向新进程（配合 G1 的 workspace.info 扩展）。

## 4. 验证（证据 `evidence/2026-10-26-p6-g2/`）

| 命令 | 结果 |
| --- | --- |
| `npm run build` + `desktop:build:shell` | exit 0 |
| 单测（protocol/core/service G2 + preflight + 既有相关套件） | 35/35 PASS（`02-unit-g2.log`） |
| shell E2E **8 场景**（G1 6 场景回归 + G2 2 场景） | **8/8 PASS（31.9s，`04-shell-e2e-g2.log`）**：G2 场景 1=安装 archivist→详情（pack 哈希/initialized=false/current_instance=null）→grant→回读→revoke→回读→最近列表移除且目录仍在→角色页无会话入口；场景 2=本机真实 ZCode CLI 分支：预检 CLI ok→以 zcode 模式启动→`模式：zcode`、诊断 `adapter=zcode`→stop 回收 |
| 探针 E2E（G0 回归） | 1/1 PASS（`05-probe-e2e.log`） |
| `npm run check` | exit 0：**49 文件 / 506 测试全绿**（`07-check.log`；首轮在 E2E/打包重负载后出现一次 core 既有测试 30s 超时，单跑 46/46 通过，机器空闲后全量重跑通过——负载偶发，vitest.config 已注明该特性） |
| 打包 `desktop:package:shell` + 冒烟 | exit 0；空工作空间 running（`08-packaged-shell.json/.png`） |

## 5. 失败、跳过与未验证项

1. **锚定/会话演示不做**（留 G3）：角色页无任何会话入口，E2E 断言页面含"不会打开会话"且无锚定控件。
2. **真实连接测试按钮的支出边界**：实现为 connector 握手（tools/list，零会话零模型轮）；按钮文案注明独立动作。带 helper 的完整真实连接（模型可用性）留 G3 真实会话接入验证。
3. **受管模式（--sandbox + egress）的真实启动未在 E2E 执行**：预检面板校验白名单合法性（planEgress），bwrap 干跑通过；带沙箱的真实服务启动属 G3 会话执行前置，本轮只验证配置链路与受限声明如实显示。
4. **credential helper 未配置时**：连接器握手可用（零模型操作），模型轮按连接器语义如实失败——本轮未触达模型轮，G3 验证。
5. **策略撤销后"下一次角色动作按核心拒绝"**：G2 无会话可发起动作；已验证策略表回读与核心 `policy.evaluate` 既有测试（P1-P5 套件），端到端拒绝演示留 G3 会话链。
6. 全量 check 一次负载偶发超时（§4），复跑通过；已如实记录。

## 6. 规范/文档更新

- 契约 v4：§2.3 三个 G2 操作标注"已实现"（含 runtimeStatus 的 service/桌面预检切分与分页约定）；§4 shell 清单补 `roles` namespace 与 workspace 新方法；文头版本注记。
- toolchain：service→adapter-zcode 工作区依赖、service bin 新模式、vendor 连接器 bundle、新 Schema 清单。
- 无新 ADR：无权限模型/架构变化（service bin launcher 是既有 WorkspaceService 注入点的配置化）。

## 7. 下一阶段可用输入与遗留

- 可用输入：真实 zcode 工作空间已在 GUI 可启动（G3 原会话接入的服务底座）、launcher 配置与预检面板、角色/策略管理面、G-min 确认页。
- 遗留（后续阶段）：原会话接入与人类确认（G3）、受管沙箱真实执行、策略撤销的端到端拒绝演示（G3）、checkpoint/知识页面（G5）。

## 8. 停止点声明

本报告完成后停止：未 `git commit`、未进入 G3、无授权确认/锚定演示、无远程发布。请独立验收 Agent 按 `prompts/REVIEW.md` 形成 `P6-G2-review.md`。

## 9. 验收返工说明（2026-10-26，按 P6-G2-review.md G2-R01–R06）

首轮验收 **REWORK**，六项全部修复：

### G2-R01 — 目录↔workspace_id 身份绑定（P1）

- workspace_id 是创建时随机生成、存于 state.sqlite 的值，无法从路径派生。新增：service bin 启动时把 `workspaceId` 写入 `<root>/.roledock/workspace-id`（0600，O_NOFOLLOW，停止时删除）——启动器因此可以**不触碰锁定的 SQLite writer** 就建立目录→身份的对应。
- supervisor：附着探活成功后读取该身份文件，**期望与端点实际 workspace_id 不一致 → conflict**（"目录身份不匹配：目录记录 X，端点实际 Y；已拒绝附着，不执行任何写操作"）；自有启动就绪时同样核对（双保险）。
- E2E 新场景：起 A/B 两个真实服务→把 B 的 owner-connection 覆盖到 A→GUI 打开 A→卡片显示"目录身份不匹配"+B 的 id+conflict→经该视图安装角色被拒→B 工作空间未被污染。渲染层自报 ID 从不参与判定。

### G2-R02 — 每工作空间 launcher 持久化与恢复

- `.roledock/launcher-config.json` 成为**每工作空间启动配置的持久引用**：`open()` 未显式指定模式时优先使用它——restart、SIGKILL 崩溃重开、从最近记录重开全部保持真实配置；句柄内 `launcher` 引用使 restart 显式传回。
- 显式 UI 选择仍是设置入口（zcode 选择会更新配置文件）；配置失效（如 CLI 缺失）时启动**显式失败**，绝不自动退回 mock（E2E 断言错误提示指向 CLI 配置）。
- E2E：真实 zcode 启动→restart→等待诊断重新可用→`adapter=zcode`、卡片 `模式：zcode`。

### G2-R03 — 连接器按真实文件路径解析

- main 进程按环境解析：packaged → `resources/runtime/vendor/zcode-connector.mjs`（extraResources 真实文件），dev → `dist-desktop/vendor/`——不再指向 asar 内部路径。
- 预检 connector_bundle 检查从 Electron `existsSync` 改为 **`node --check`**（由锁定 Node 真实加载验证）。
- 打包版真实分支全链冒烟（`14-packaged-g2-rework.json/.png`）：预检 connector ok（--check 通过）→ 连接测试握手成功（server=roledock-zcode-reference@0.5.0，9 工具，零会话零模型轮）→ zcode 模式启动 running → 诊断 adapter=zcode、runtime=v22.23.2（锁定运行时）。

### G2-R04 — 移除最近记录持久化

- `workspace.removeRecent` 现在 `saveSettingsFile` 写回后再返回；E2E 断言：移除后 `settings.get` 立即重读不含该项，且重新进入页面后 DOM 亦不含；目录本体保持存在。

### G2-R05 — launcher 配置写入防链接（P1）

- `writeLauncherConfigFile` 重写：`.roledock` 必须是**真实目录且属主为当前用户**（lstat 拒绝符号链接）；已存在配置必须是常规属主文件；新内容写入 **O_EXCL|O_NOFOLLOW 的临时文件**（0600）后 **rename 原子替换**——rename 替换符号链接本身而非目标，原内容保留到新配置完整落盘。
- 单测 3 项：首次写入/更新 0600；**符号链接配置端点被拒绝且目标内容/权限完全不变、链接仍在**；`.roledock` 为符号链接时拒绝且目标目录无任何写入。

### G2-R06 — 角色详情返回安装快照真实正文

- `roleDetails` 现从**安装快照**（`packs/<store_path>/`，content_hash 对应副本，非可变源目录）解析：`instructions`/`documents[].template`/`output_schemas[].schema` 的路径引用解析为可读正文（带 128KiB 上限与越界拒绝；非路径值视为内联文本原样返回）。
- 协议 `RoleDocumentTemplate` 增加 `template` 字段，`role-details` Schema 同步（template 必填）；**`roles.get`/`policy.list` 在 service 传输边界按 Schema 校验后返回**（落实上轮 §5 备注）。
- 角色页渲染职责正文 `<pre>`、每份模板正文、每个输出 Schema 内容。单测：reviewer 详情 `instructions` 含 "# Reviewer" 且不以 .md 结尾、模板正文非路径、Schema JSON 可解析。

### 回归与证据

干净构建后：shell E2E **9 场景全过**（上轮新增 G2-R01 身份冲突、R02 重启保持场景；R05/06 由单测+E2E 覆盖；数量以 `11-shell-e2e-rework.log` 为准，此前正文误写 10）、探针 E2E、打包版真实分支全链冒烟、`npm run check` 全绿。证据 `evidence/2026-10-26-p6-g2/`（`11-shell-e2e-rework.log`、`12-unit-rework.log`、`13-check-rework.log`、`14-packaged-g2-rework.json/.png`）。状态保持**待独立验收（返工完成，再次提请复验）**。

## 10. 复验返工说明 v2（2026-10-26，按 P6-G2-rework-review.md）

复验裁定：R03/R04/R05 关闭；**R01/R02/R06 未闭环**。三项本轮修复（基线仍 HEAD `d9743365` + 未提交工作区）：

### G2-R01（续）— 身份跨停机持久；无身份不得附着活端点（P1）

- 根因：上一轮把 workspace-id 文件做成了"服务生命周期随行文件"（停止即删），且附着把"读取失败/缺失"当 null 放行。
- 修复：**身份文件跨停机持久**（bin 的 stop 不再删除——它是目录的稳定工作空间记录）；`readWorkspaceId` 分型 absent/present/corrupt（lstat 拒绝符号链接与非常规文件、内容必须是合法 workspace_id）；**活端点附着必须证明身份**——absent 与 corrupt 都返回 conflict（"目录缺少身份记录/身份文件损坏，无法证明端点归属；已拒绝附着与写操作"），不匹配亦然。自有启动就绪时同样三态核对。
- E2E 新场景：A/B 真实服务→**A 正常 SIGTERM 停止**→断言 owner 文件已删而 workspace-id 仍在→植入 B 的 0600 连接文件→GUI 打开 A→conflict+"目录身份不匹配"+B 的 id→安装被拒→B 未被污染。原双活冲突场景保留通过。
- 正常 A/B 切换、崩溃恢复、重启均不受影响（既有 E2E 回归通过）。不覆盖未知端点、不争抢 SQLite writer。

### G2-R02（续）— 损坏持久配置显式失败，绝不静默 mock

- `persistedLauncher` 分型 absent/present/error：符号链接、非常规文件、内容损坏、类型不可识别均为 **error**；`open()` 无显式 launcher 且 error → 返回 `state=error`（"持久化启动配置不可用（…）；已保留原端点，不会改用 mock 启动。请修复或删除该配置后重试"），**不启动任何服务**。
- absent（全新目录）保持 mock 诊断入口可用；present 保持真实恢复（上轮已验证的 restart/停止重开/应用重开/SIGKILL 重开全部保留）。
- E2E 新场景：建立真实 zcode 工作空间→停止→把 launcher-config.json 换成指向合成文件的符号链接→以最近记录路径（无显式 launcher 的 IPC open）重开→`state=error`+文案，链接与其目标原样，**无 service.sock**（没有 mock 被启动）。

### G2-R06（续）— 按包契约统一解析材料路径，失败显式

- `#packText` 移除扩展名/内联文本猜测：rolepack Schema 定义 instructions/template/schema 为**包相对文件路径**（扩展名不是契约的一部分），一律按路径在安装快照内解析；材料缺失/非常规文件/不可读 → `INTERNAL` 显式错误（注明内容由 content_hash 固定、来源目录可能已变化），**绝不再把路径伪装成正文**。NUL 字节拒绝、越界拒绝、128KiB 上限保持。
- 单测：无扩展名合法包（materials/guide|layout|record）三份材料全部返回真实正文（含 JSON Schema 可解析）；**删除安装副本中的材料后 roles.get 显式失败**（对照：安装快照由哈希固定，与源目录无关）。
- 服务边界 `role-details` Schema 校验保持（上轮已加），UI 渲染保持。

### 报告更正

上轮 §9 所述"shell E2E 10 场景"应为 **9 场景**（以 `04-shell-e2e.log` 为准）；本轮为 **11 场景**（`15-shell-e2e-r2.log`）。

### 回归与证据

干净构建后：shell E2E **11 场景全过**、单测（service/protocol/desktop 相关 18 项）、`npm run check` 全绿、打包产物真实分支冒烟见上轮 14 号证据（本轮源码未触及连接器路径逻辑）。证据 `evidence/2026-10-26-p6-g2/`（`15-shell-e2e-r2.log`、`16-unit-r2.log`、`17-check-r2.log`）。状态保持**待独立验收（第二次返工完成，再次提请复验）**。
