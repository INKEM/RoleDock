# P6-G2 返工独立验收

> 后续最新独立裁定见 [P6-G2-final-review.md](P6-G2-final-review.md)：**PASS**，本报告遗留的 R01/R02/R06 已关闭。下文保留本轮历史 REWORK 结果。

日期：2026-10-26。结论：**REWORK**。上一轮六项中，**G2-R03/R04/R05 关闭；G2-R01/R02/R06 尚未闭环**。正常 ZCode 生命周期、打包连接器、最近记录持久化和配置写入保护已有实质改善，但仍能误连另一工作空间；异常配置端点仍会退回 mock；合法无扩展名角色材料仍没有正文。不得进入 G3。

## 1. 范围与基线

按用户“验收返工成果”，复验 [上一轮 G2 验收](P6-G2-review.md) 的六项及 [开发报告 §9](P6-G2-development.md)。依据 AGENTS、DEVELOPMENT_PLAN、toolchain、DESKTOP_GUI_PLAN、ADR-0013、desktop-gui-contract、COMMON、REVIEW 和 06G2 提示词。G0/G1 的独立 PASS 仍为前置历史裁定，不替代本轮受影响路径的回归。

基线为 HEAD `d9743365256459a773a5319791cf3b7bb2e5fbe7` 加当前未提交工作区。源码、Schema、测试、构建脚本、锁文件、契约和开发报告共 **129 文件**，验收前后哈希一致，见 [baseline-verification.json](evidence/2026-10-26-p6-g2-rework-independent/baseline-verification.json)。未修改产品实现、契约或开发报告；仅增加验收报告、复现材料和原报告的新裁定指针。没有提交、合并或发布。

## 2. 六项返工对照

| 原编号 | 本轮实际结果 | 裁定 |
| --- | --- | --- |
| R01 目录与服务身份 | A/B 均运行且身份文件存在时，新增冲突 E2E 通过；A 正常停止后文件被删除，放入 B 的连接信息仍附着 B，安装实际写入 B | **未关闭，P1** |
| R02 launcher 生命周期 | 新打包版 restart、停止重开、应用重开、SIGKILL 后重开均保持 zcode 和 workspace_id；CLI 路径失效明确 disconnected。但持久配置为符号链接时被当成“没有配置”，同一工作空间静默以 mock running | **部分修复，未关闭，P2** |
| R03 打包连接器 | 新构建 Linux dir 产物从源码仓库以外的临时工作目录启动；包外 runtime/vendor 连接器预检、握手、adapter=zcode 启动均通过，mock 对照通过 | **关闭** |
| R04 最近记录持久化 | IPC 写回后设置回读、磁盘 JSON、应用重启回读均不含移除项；实际工作空间仍存在。现有 E2E 的点击／页面重入通过 | **关闭** |
| R05 配置写入保护 | 正常首次写入和更新为 0600；配置文件链接、状态目录链接均拒绝，合成目标的内容、权限、inode／链接及空目录状态保持 | **关闭已复现问题** |
| R06 真实角色正文 | 标准 .md/.json 的职责、模板、Schema 均与文件正文精确一致；服务已应用新增 Schema。合法无扩展名文件仍被当作内联文本，三项均返回路径 | **部分修复，未关闭，P2** |

安装不 grant、initialized 提示、选择角色不打开会话、grant/revoke 回读、owner/session 权限分离、有限 IPC、同目录单 writer 的相关专项及 G1/G2 E2E 通过。核心无具体业务角色专项通过。未把这些常规测试的全绿解释为上述三个反例已解决。

## 3. 必须继续返工

### G2-R01 — [P1] 身份标记随正常停机删除，原始跨工作空间误连仍可复现

**位置**：`packages/service/src/bin.ts:94–106`；`packages/desktop/src/shell/supervisor.ts:112–119`、`:330–335`。

**触发**：在本轮隔离临时目录创建 A、B 两个工作空间，记录各自 ID；对 A 发 SIGTERM 并等待退出，把 B 的合法 owner-connection 写入 A，再经当前 WorkspaceController 打开 A 并安装 custom-role。该控制器正是桌面 IPC 使用的 owner 操作入口；没有绕过 supervisor 或直接向 B 发安装操作。

**实际**：A 原 ID `ws-767632ae`；停机后 `identityFileAfterStop=false`。打开 A 的结果却为 B 的 `ws-4ab3c6ad`、`state=running`、`owned=false`。随后经 A 的 controller 安装成功，B 的 roles.list 出现 `archivist`。见 [10-identity.json](evidence/2026-10-26-p6-g2-rework-independent/10-identity.json) 与 [复现脚本](evidence/2026-10-26-p6-g2-rework-independent/check-identity.mjs)。所有凭据和角色数据都来自验收自建的临时 A/B。

**原因／影响**：stop 删除了本应跨生命周期稳定的目录身份；读取失败或内容不合法又返回 null，附着仅在 expected 非 null 且不同才拒绝。因而新增“两个服务都活着”的测试通过，原“停止 A 后恢复了错误连接文件”的场景仍会将后续角色／策略操作发送到 B。

**修复要求**：建立停机后仍有效的可信目录身份，并区分首次建立、遗留目录、缺失／损坏身份和活端点不匹配。已有目录对活端点的身份无法确认时须拒绝附着及 owner 写操作；不能把 null 当成已验证，也不能以覆盖未知端点或争抢 SQLite writer 恢复。

**复验**：保留现有活 A/B 冲突测试；增加 A 正常停止后误放 B 连接、身份缺失／损坏、陈旧连接恢复、正确停止重开／崩溃恢复等场景。拒绝时 B 的角色与策略必须无变化；正常 A/B 切换不串数据。

### G2-R02 — [P2] 异常持久配置被当成不存在，仍会静默启动 mock

**位置**：`packages/desktop/src/shell/supervisor.ts:95`、`:140–145`、`:340–346`。

**已通过**：新的打包产物中，正常配置的 restart、停止重开、退出应用重开、受控 SIGKILL 后重开均保持 adapter=zcode；缺失 CLI 对应 disconnected，mode 仍为 zcode。原正常重启丢配置问题已修复。

**剩余触发**：在同一已建立 ZCode 的工作空间停止服务后，将 launcher-config.json 替换成指向临时合成配置文件的符号链接；不显式提供新 launcher，调用 workspace.open 重开。这也对应页面默认 mock 选择下的最近记录打开路径，因为 controller 对该选择不传 configPath。

**实际**：`persistedLauncher` 检查发现非正常端点后返回 undefined，随后走 `--mock-workspace`；同一 `ws-404641f5` 成为 `running/mode=mock`，诊断 `adapter=mock`。链接本身及目标内容保持，说明 R05 的写入保护没有回归；问题在读取恢复时把“配置不可用”变为“没有配置”。见 [09-packaged.json](evidence/2026-10-26-p6-g2-rework-independent/09-packaged.json) 的 linkedConfigOpen／linkedConfigDiagnostics。

**影响／修复要求**：恢复已有真实工作空间仍可能无提示改变后端语义。配置读取应区分 absent、valid、conflict/error；检测到链接、非文件、读取异常等情况应显示配置冲突／失败，保留原端点，不自动选择 mock。保持正常无配置的新工作空间诊断入口可用。

**复验**：在现有真实配置生命周期测试外，加入配置端点为链接／目录、内容损坏、不可读等情况，断言没有 mock 服务被启动；原文件和目标不变，配置修复后能以原工作空间 ID 恢复 zcode。

### G2-R06 — [P2] 用文件扩展名猜测材料类型，合法角色包仍只显示路径

**位置**：`packages/core/src/admin.ts:136–151`；对照 `packages/protocol/schemas/rolepack.schema.json` 的 `$defs/packagePath` 及 instructions/template/schema 引用。

**触发**：本轮新建不同于内置示例的角色包，三份材料为 `materials/guide`、`materials/layout`、`materials/record`，分别写入职责 Markdown、模板和合法 JSON Schema。manifest 通过 validateRolePack，实际 roles.install 成功，再经真实 Unix socket 的 owner RPC 查询 roles.get。

**实际**：instructions、documents[0].template、output_schemas[0].schema 原样返回上述三个路径，与正文的精确对照全部 false。见 [06-materials.json](evidence/2026-10-26-p6-g2-rework-independent/06-materials.json) 和 [复现脚本](evidence/2026-10-26-p6-g2-rework-independent/check-materials.mjs)。标准示例带扩展名的三项精确正文对照全部 true，记录在 09-packaged.json 的 standardMaterials。

**原因／影响**：包 Schema 明确这些值是包内文件路径，没有要求扩展名，也没有声明内联文本分支；`#packText` 却把没有后缀的引用直接当成正文。此外非文件／读取失败仍退回路径字符串。因而当前响应即使满足 string 类型，也不能证明角色材料已读取，未满足任意合法角色包详情要求。

**修复要求**：按包契约统一解析已安装快照中的路径，不用扩展名推断内联文本；材料丢失／损坏应给出明确错误或契约化状态，不能把路径伪装为成功正文。继续保持路径边界、纯文本呈现和合理内容限制。

**复验**：扩展名与无扩展名的合法包均显示真实职责／模板／Schema；对照安装快照与包哈希，修改来源目录后正文保持原快照；缺失／损坏材料如实失败；详情查询不创建会话、安装不 grant。

## 4. 独立运行与证据

证据目录：[2026-10-26-p6-g2-rework-independent](evidence/2026-10-26-p6-g2-rework-independent/)。Node 22.23.2；固定随包运行时 v22.23.2；实际预检本机 ZCode CLI **0.17.0**；bubblewrap 0.6.1 干跑通过。Unix socket、Electron 与本机 CLI 通过本地自动审批执行。真实分支仅版本查询、连接器握手与服务底座启动，**零真实会话、零模型轮**。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `01-typecheck.log` |
| `npm run desktop:build:shell` | exit 0 | `02-build-shell.log` |
| vitest：desktop/protocol/service/MCP/服务重启/核心策略/无业务角色等十四文件 | **122/122 PASS**，exit 0 | `03-focused.log` |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts` | **9/9 PASS**，exit 0，约 1 分钟；无跳过，本机进入 ZCode 存在分支 | `04-shell-e2e.log` |
| 自定义 GUI 扩展探针两次尝试 | 均 exit 1，分别在状态转换期间得到 ENOENT／无 owner 连接；不算成功，也未凭此单独追加产品问题 | `05a-gui-timing-attempt.stderr`、`05-gui.stderr`、`revalidate-gui.mjs` |
| 合法无扩展名材料独立反例 | 取证 exit 0，三项正文对照 false，R06 未关闭 | `06-materials.json/.stderr`、`check-materials.mjs` |
| 配置文件保护独立检查 | exit 0；正常写入／更新、链接拒绝与目标保持全部 true | `07-config-safety.json`、`check-config-safety.mjs` |
| `npm run desktop:package:shell` | exit 0，新建 Linux dir 产物 | `08-package-shell.log` |
| 新打包产物实际运行与生命周期、最近记录检查 | 取证 exit 0；11 项正常／CLI 失效检查 true，标准材料三项精确对照 true；另观测到配置链接→mock 反例，不能把脚本退出 0 当成该边界通过 | `09-packaged.json/.stderr/.png`、`check-packaged.mjs` |
| 停止 A 后误连 B 原始场景 | 取证 exit 0，A 的 owner 操作实际写入 B，R01 未关闭 | `10-identity.json/.stderr`、`check-identity.mjs` |

前两次自定义 GUI 探针的失败日志完整保留。它们没有完成合并探针的全部预期；后续使用逐项 await 的新打包窗口 IPC 检查与独立 controller/service 反例分别取证，不把早期失败改记为通过，也不以未确定原因的时序错误代替确定反例。

开发报告称“shell E2E 10 场景”，当前源码及独立执行实际为 **9 场景**；应据日志更正数量。开发方全量 check 的 50 文件／510 测试通过日志仅作开发证据；本轮没有重新运行全量 `npm run check` 或 `npm ci`，未充作独立通过数。

## 5. 边界与停止点

- G0 探针未在本轮单独重跑；G1 shell 相关 E2E 已回归。原生目录实际人工选择没有新增采样，E2E 使用文档化目录 fixture。
- 新打包窗口扩展验证通过有限 preload IPC 驱动，与现有按钮 E2E 分开记录；不声称每个扩展步骤都经手工点击。
- 受管沙箱真实模型执行、外部桌面原会话、人类确认与 Agent 显式锚定仍留 G3/G7。握手与诊断 adapter=zcode 不代表这些能力已验收。
- R05 关闭的是本轮实际复现的常规文件／链接覆盖问题，不宣称穷尽任意并发文件系统攻击。

下一步仅继续修复 **R01、R02、R06**，更新开发报告和基线后再次独立复验。**G2 仍为 REWORK，不进入 G3。**
