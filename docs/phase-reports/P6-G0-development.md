# P6-G0 开发报告：技术探针与 GUI 操作契约

日期：2026-10-25；**v2 返工修订 2026-10-26**（按 [P6-G0-review.md](P6-G0-review.md) R01–R04，见 §9）。**状态：待独立验收（返工后再次提请复验）。**

## 1. 实际基线

- HEAD：`d9743365256459a773a5319791cf3b7bb2e5fbe7`（2026-10-25 21:21 +0800）。
- 工作区：HEAD 之上原有未提交的计划文档重编改动（AGENTS/README/DESKTOP_GUI_PLAN/DEVELOPMENT_PLAN/prompts + ADR-0013 + 06Gx 提示词），**全部原样保留、未提交**；本阶段所有改动叠加其上（见 §4）。完整快照见证据 `01-baseline.txt` 与 `git status`。

## 2. 交付与验收条件对照（提示词 `prompts/06G0-contract-and-spike.md`）

| 提示词要求 | 交付 | 结论 |
| --- | --- | --- |
| 冻结 HEAD/工作区，核对 desktop/service/mcp/zcode 真实能力 | 能力盘点（已有/缺失/计划，含 file:line）写入契约文档 §1；`admin.events`=一次性 SELECT 非订阅、owner 无 documents/bindings/requests 详情均如实落档 | 完成 |
| Electron + TS UI + 独立 Node 22.23.2 服务探针（窗口/IPC/目录选择/SQLite/MCP 子进程/打包路径）定档 | `packages/desktop/src/probe/` 探针 + scripts；真实窗口 E2E、dev 自检、打包自检、打包窗口探针全 PASS（§5） | 完成 |
| 契约：owner 读模型、渲染层具名接口、可见性、管理取消、候选提议、幂等 | `docs/spec/desktop-gui-contract.md` §2–§6（16 项操作名、可见性矩阵、幂等规则、归属约束）；正式发布仍走原会话 | 完成 |
| 官方接口核查并精确固定依赖/构建器/E2E 工具；更新 toolchain 与 ADR-0013；探针用临时 mock 工作空间 | toolchain「P6-G0 桌面技术定档」节 + ADR-0013 定稿（提案→已定档+定档结果节）；探针只用 `--mock-workspace` 临时目录，未发送任何真实模型任务、未接真实 ZCode | 完成 |
| 退出：探针可运行且打包后能找到固定运行时；渲染层无凭据/任意 RPC；操作映射与可见性完整；单 writer 和生命周期有实测 | 打包自检 `mode=packaged` PASS（`resources/runtime/node` → v22.23.2）；E2E 断言封闭清单/无 64-hex token；契约表不含依赖不存在 RPC 的页面承诺（§3/§5 说明"未实施"）；单 writer（errcode=5）与生命周期（关窗保留/退出回收/单实例/锁释放）E2E 实测 | 满足 |
| 不做五页面 | 仅探针面板（单一页面，仅为探针运行），无产品页面 | 满足 |

## 3. 主要文件与公共接口变化

新增：

- `packages/desktop/src/probe/`：`shared/bridge.ts`（具名 IPC 清单 + `createBridgeApi` + `redact` + SQLite BUSY 探针脚本）、`runtime.ts`（打包/dev 运行时解析）、`supervisor.ts`（服务子进程监督：启动/就绪等待/SIGTERM 停止/锁释放验证）、`mcp-probe.ts`（MCP stdio 握手）、`main.ts`（Electron main：单实例锁、具名 IPC、四项检查、`--selfcheck`、状态文件）、`preload.ts`（沙箱 contextBridge）、`renderer/`（无框架 TS 面板 + 严格 CSP）。
- `packages/desktop/scripts/`：`build.mjs`（esbuild 五个 bundle + schemas 拷贝）、`fetch-runtime.mjs`（官方 dist + SHA256）、`probe.mjs`（dev 启动器）、`dialog-evidence.mjs`、`packaged-evidence.mjs`。
- `packages/desktop/`：`electron-builder.yml`（dir+deb 配置）、`playwright.config.ts`、`test/probe-contract.test.ts`（清单封闭/脱敏/运行时解析单测）、`test/e2e/probe.e2e.spec.ts`（真实窗口全生命周期）。
- `docs/spec/desktop-gui-contract.md`（G0 契约定档，未实施）；`docs/phase-reports/evidence/2026-10-25-p6-g0/`。

修改：

- `packages/desktop/package.json`：devDependencies 精确固定 electron 44.9.3 / esbuild 0.28.2 / electron-builder 26.18.0 / @playwright/test 1.64.1 / @modelcontextprotocol/sdk 1.32.1；`main` 指向探针（打包用）；`homepage` 占位。G-min 代码与 bin 未动。
- 根 `package.json`：新增 `desktop:runtime|build|probe|e2e|package`；`package-lock.json` 更新（含 audit fix）。
- `tsconfig.check.json`：`lib` 增加 DOM（渲染层代码纳入全量 noEmit 检查）。
- `docs/toolchain.md`（定档节）、`docs/adr/0013-…`（定稿）、`docs/DESKTOP_GUI_PLAN.md` §5.1（契约指针）、`.gitignore`（探针产物目录）。

探针产物布局（构建生成，gitignore）：`dist-desktop/{vendor/{main.mjs,preload.cjs,service-bundle.mjs,mcp-bundle.mjs},renderer/,schemas/}`；打包产物 `dist-app/linux-unpacked/` 与 `dist-app/@roledock/desktop-0.1.0-alpha.0-amd64.deb`。关键约束：凡嵌入 `@roledock/protocol` 的 bundle 必须放 `vendor/`、上一层放 `schemas/`（协议在运行时按 `import.meta.url` 相对读 Schema）。

## 4. 验证（全部真实运行，证据见 `evidence/2026-10-25-p6-g0/`）

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm view {electron,esbuild,electron-builder,@playwright/test} version engines` | 定档 electron 44.9.3（45.0.0 发布仅 4 天不取，稳定线惯例）、esbuild 0.28.2、electron-builder 26.18.0、@playwright/test 1.64.1 | `02a-npm-versions.txt` |
| `npm install` + `ELECTRON_GET_USE_PROXY=1 npx install-electron`；`npm audit fix` | 0 漏洞；electron v44.9.3 二进制可用；本机代理下 Node fetch 需官方 `ELECTRON_GET_USE_PROXY` 开关（@electron/get 5.1.0 不读代理 env） | `02b-install-audit.txt` |
| `npm run desktop:runtime` | 官方 dist v22.23.2 下载 + SHA256 校验通过 | `03-selfcheck-dev.*` 同目录运行记录 |
| `node packages/desktop/scripts/probe.mjs --selfcheck`（dev，无窗口） | **PASS**：runtime_version v22.23.2、workspace_info、sqlite_single_writer errcode=5 "database is locked"、mcp_subprocess 14 工具 + authorizations.get ok | `03-selfcheck-dev.json` |
| `npx playwright test --config packages/desktop/playwright.config.ts`（dev 真实窗口，DISPLAY=:0） | **PASS（5.7s）**：具名 IPC 封闭清单（无 rpc/call/invoke、渲染层无 process/require）、页面无 64-hex token、服务启动、四项检查全 ✅、目录选择 fixture 回读、关窗保留服务（owner RPC 仍答）、二次启动被单实例锁拒、退出回收服务子进程、锁释放后同工作空间可重开 | `04-e2e-dev.log`、`screenshots/e2e-1…2…png` |
| `node scripts/dialog-evidence.mjs`（真实原生目录对话框） | X11 窗口树证实 `"RoleDock 探针：选择目录"` 对话框窗口存在（xdg-desktop-portal-gnome）；人手点选未自动化 | `05-dialog-evidence.json`、`screenshots/e2e-4-native-dialog.page.png` |
| `npx electron-builder --linux dir --publish never`；`./dist-app/linux-unpacked/roledock-desktop-probe --selfcheck` | 打包 exit 0；自检 **PASS，`mode=packaged`**，运行时 `resources/runtime/node/node` → v22.23.2 | `06-packaging.txt` |
| `node scripts/packaged-evidence.mjs …`（打包产物真实窗口 UI 全链） | **PASS**：四项检查在打包产物内全 ✅（source=packaged） | `06-packaging.txt`、`screenshots/e2e-5-packaged-checks.png` |
| `npx electron-builder --linux deb --publish never` | 第 1/2 次失败（缺 homepage；scope 目录 fpm 不自建）→ 修复后 **exit 0**，产物 133 MB deb | `06-packaging.txt` |
| `npx vitest run packages/desktop/test/probe-contract.test.ts` | 4/4 PASS | `09-check.log` 含同套件 |
| `npm run check`（tsc -b --force + 全量 noEmit + build + vitest 全套） | **exit 0：43 个测试文件 / 460 测试全部通过**（既有套件 + 新增探针契约测试；G-min 行为不回归） | `09-check.log` |

## 5. 失败、跳过与未验证项（如实记录）

1. **原生对话框人手点选未自动化**：本机无 xdotool，GTK/portal 对话框内的人类点选不可脚本化；已用两条互补证据覆盖——(a) E2E 经文档化的 dialog fixture 证明 IPC 全链与选中路径回读（代码中 fixture 旁路有显式日志 `dialog-fixture-used`）；(b) X11 窗口树证明真实对话框窗口存在。真实点选交互留给验收方按 §4 命令复现（与 G-min 遗留的浏览器点击矩阵同属 G3/G7 交互验收范围）。
2. **deb 未做安装验证**：deb 可出包已证实；`dpkg -i` 安装/升级/卸载矩阵留 G7（计划 §8/§15）。
3. **打包产物的 chrome-sandbox/发布签名**：dir 产物在开发用户会话运行；setuid sandbox、desktop 文件、签名等发行事项留 G7。
4. **Electron 45.0.0 未取**：发布仅 4 天，按仓库稳定线惯例定 44.9.3；升级另行走 toolchain 变更流程。
5. 探针使用 mock 适配器种子会话（`mock-existing-conversation`/`mock-fixture-subject`）完成 trusted→session 凭据链，这是探针专属接线，**不是**产品接入形态（G2/G3 另行实现）。

## 6. 规范/ADR 更新与影响

- `docs/spec/desktop-gui-contract.md`（新增）：owner 读模型 16 项操作契约（名称/输入输出/分页/脱敏）、可见性矩阵（请求正文对 owner 可见+凭据脱敏——用户确认；private/role 正文仅元数据+哈希；宿主私聊与凭据永不可见）、幂等规则（可选 `idempotency_key`，现 18 操作不变）、管理取消/候选提议归属约束、生命周期矩阵。**状态"定档、未实施"**；实现子阶段先补 protocol Schema，实现前不占稳定协议名。
- `docs/toolchain.md`：新增「P6-G0 桌面技术定档」节（精确版本、官方依据、代理注意、audit 记录、新命令）。
- `docs/adr/0013`：状态 提案→已定档（**2026-10-26 已按 R04 回退为"候选定档／待独立验收"，见 §9**），追加「P6-G0 定档结果」节。
- `docs/DESKTOP_GUI_PLAN.md` §5.1：追加契约文档指针。
- 影响范围：仅 `packages/desktop` 新增能力与根构建脚本；core/service/mcp/协议零改动。

## 7. 下一阶段可用输入与遗留

- 可用输入：定档技术栈与探针（G1 外壳可直接复用 supervisor/runtime/bridge 模式与打包布局）、契约文档（G2–G6 按表补 Schema）、`desktop:*` 命令、打包配置基线。
- 尚未满足（属后续子阶段，非 G0 退出条件）：真实工作空间接入与服务发现/附着（G2）、真实 ZCode 桌面原会话（G3）、轮询性能（G4）、deb 安装验证与点击矩阵（G7）。

## 8. 停止点声明

按提示词与 COMMON 约束，本报告完成后停止：未 `git commit`、未进入 G1、未做五页面、无远程发布。请独立验收 Agent 按 `prompts/REVIEW.md` 形成 `P6-G0-review.md`。

## 9. 返工说明（2026-10-26，按 P6-G0-review.md R01–R04）

首轮独立验收结论 **REWORK**（2026-10-26）。四项返工全部完成；技术选型与探针链路（验收方已独立复现）未改动，仅按复验要求调整脱敏实现与契约文档、回退 ADR 状态。返工后基线仍为 HEAD `d9743365` + 未提交工作区（返工改动叠加，无提交）。

### R01 — 脱敏分层定档（代码 + 契约 §3.1 重写）

- `packages/desktop/src/probe/shared/bridge.ts`：`redact()` 从"键名含 authorization 即删"的子串规则改为**两层**——(1) `SECRET_FIELD` 字段名精确后缀拒绝清单（`token|secret|password|bearer|api_key|private_key|access_key`），**不再误删** `authorization_id`/`active_authorization` 等公开业务标识；(2) 新增 `scrubDisplayText()`：对字符串做尽力而为的显示投影（`Bearer <值>`、`键: 值`、≥32 位十六进制 → `[masked]`，**标签保留**）。文档注释与代码声明一致：scrub 是显示卫生，不证明文本无秘密。
- 单测重写（`test/probe-contract.test.ts`，4→6 项）：合成授权 DTO 断言 `authorization_id`/`active_authorization` 保留、秘密字段（`session_token`/`owner_credential_token`/`api_key`）被拒；`"Authorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL rejected"` → `"Authorization: Bearer [masked] rejected"`（标签保留，哨兵值消失）；普通散文与 `document_key` 不动；base64 形态混淆串**不在**掩盖范围（固化"尽力而为"边界，不以正则冒充秘密证明）。
- 契约 `§3.1` 重写为四层：字段投影（权威，实现期随 Schema 定 DTO 白名单）→ 字段名拒绝（传输兜底）→ 自由文本显示投影（尽力而为）→ 内容哈希（永远对应原始字节，脱敏文本不得标注为哈希对应字节）。§4 同步。

### R02 — 管理取消对齐真实状态机（契约 §6 重写）

- 废除不存在的 `awaiting`；矩阵覆盖协议全部 8 状态（`accepted, queued, running, awaiting_input, completed, failed, cancelled, expired`，`collaboration-request.schema.json:65-77`）+ `execution_uncertain` 子状态。
- 逐状态给出同键重放 / 不同键取消的确定行为：`accepted|queued|awaiting_input` 可取消（→ `cancelled`，`terminal_at` 写入，`cleanup_pending=1`，对齐 `packages/core/src/requests/service.ts:436-484`）；`running` 仅当适配器声明 cancel 能力否则 `REQUEST_NOT_TERMINABLE` 且状态不变；四个终态拒绝（`REQUEST_NOT_TERMINABLE`），同键重放按 §5 返回首次结果、不产生第二次变更。
- 补齐边界语义：取消能力不足、终态已生效而宿主未确认（迟到答案拒收）、`execution_uncertain` 先对账且不得以取消为名建新请求、`cleanup_pending` 回收失败不改终态、取消通知不是可采纳产物（无 artifact/哈希，不得进 `adopt_artifact_id` 链）、独立审计 kind=`owner.request.cancel` 不借用发起会话。

### R03 — 页面动作→操作映射补全（契约 §2 重构）

- 新增 **§2.2 页面动作 → 操作映射表**：计划 §6 五页面逐动作映射到现有操作或具名契约操作（含主体、阶段）；**首版页面行为无裁剪**，无静默遗漏。
- §2.3 表新增 5 项：`workspace.runtimeStatus`（G2 受管验证状态，"已连接≠隔离已验证"分列）、`documents.listRevisions`（G5 修订发现/分页 + 比较规则：不可见正文仅哈希对照，不借接口取回正文）、`checkpoints.list`（G5 摘要；"待办"= listBindings 引用对照组合，不设冗余操作）、`artifacts.read`（G6 owner 版：原文 bytes + 原始字节哈希，读不产生写权）、`requests.listCleanup`（G6 回收视图，完成与清理失败可区分）。
- 细化既有行：`roles.get`（职责/模板/输出 Schema/包哈希/需求 vs 策略/主代次）、`requests.listInbox`（协议枚举过滤、`awaiting_input` 澄清状态、用量缺失显示 unknown 不以 0 冒充）、`requests.get`（最小输出字段全列：question/reply 正文、binding、budget、usage、`execution_uncertain`、`cleanup_pending`、error、result）、`documents.listCandidates`（候选正文全文 + 原始/当前基线 + 来源；基线正文按 §3 矩阵，不构成外泄通道）、`documents.read`（`body_included` 显式标注 + 原始字节哈希）。

### R04 — ADR 状态回退（流程）

- `docs/adr/0013` 状态由"已定档（…验收通过）"改回**候选定档（开发方）／待独立验收**，新增「定档修订历史」记录首轮 REWORK 与契约 v2 修订；复验 PASS 前不作为"G0 已通过"依据。
- `docs/DESKTOP_GUI_PLAN.md` §5.1 指针同步标注"待独立验收 + REWORK"。技术选型（Electron/独立 Node/SQLite/MCP/dir 打包链）经验收方独立复现，未被否定，维持不变。

### 返工验证

| 命令 | 结果 |
| --- | --- |
| `npx vitest run packages/desktop/test/probe-contract.test.ts` | 6/6 PASS（R01 复验断言） |
| `npx playwright test --config packages/desktop/playwright.config.ts` | PASS（真实窗口全生命周期回归，10.7s） |
| `npm run check` | exit 0：43 文件 / 460 测试全绿（见 `evidence/2026-10-25-p6-g0/10-rework-check.log`） |

探针运行时行为（具名 IPC 面、服务启停、SQLite BUSY、MCP 握手、打包布局）无变化；`dist-desktop` 产物经 `desktop:build` 重建后 E2E 直接通过。返工未触碰 core/service/mcp/协议源码。

## 10. 复验返工说明（2026-10-26，按 P6-G0-rework-review.md）

复验结论：R02、R04 关闭；**R01、R03 未关闭**。本轮修复如下（基线仍为 HEAD `d9743365` + 未提交工作区）：

### R01（续）— 结构化公开值逐字节保真（redact 分层 v3）

- 根因：v2 的 `redact()` 对**所有**字符串做自由文本掩盖，`≥32 位十六进制`规则把公开的 `content_hash`（64 hex）、`host_session_id`（32 hex）、长 hex `event_ref` 一并改写为 `[masked]`。
- 修复（`src/probe/shared/bridge.ts` 与 `src/shell/shared/redact.ts` **两桥接一致**）：掩盖只作用于**具名自由文本字段**（message/body/detail/error/note/reason/description/summary/output/text/log 类键）的字符串值，且仅掩盖**标注型**秘密（`Bearer <值>`、`键: 值`）；**结构化公开值（哈希/宿主标识/事件引用/路径）一律原样返回**；无标注秘密串不保证被掩盖——那是第 1 层 DTO 投影的职责。字段名拒绝清单（token/secret/…）保持不变，未取消任何秘密字段防护。
- 断言（两套单测同构）：真实 64 位十六进制 `content_hash`、32 位十六进制 `host_session_id`、长 hex `event_ref` **精确相等**（含嵌套数组内 `content_hash`）且全响应无 `[masked]`；既有授权 ID/秘密字段/Bearer 文本掩盖断言全部保留；"无标注 blob 不掩盖"边界以 `scrubDisplayText` 直接断言固化。
- 契约 §3.1 第 3 层改写为 v3 规则；§3.2 补结构化哈希逐字节返回说明。探针桥接按本项要求解除冻结修改，探针单测与真实窗口 E2E 回归通过。

### R03（续）— checkpoint 摘要/待办对齐协议 Checkpoint 类型

- 契约 §2.3：`checkpoints.list` 最小输出补 `handoff_summary` 元数据（format/content_hash，不含正文）与 **`todos` 概览（total/done 计数 + 未完成项 description）**；新增 **`checkpoints.get`**：`handoff_summary.body` 全文（markdown）+ content_hash、`todos[{description,done}]` 全量、`sources[]`、`user_decision_refs[]`、document_snapshots——字段语义与协议 `Checkpoint`（`packages/protocol/src/types.ts:118-144`）一致。
- §2.2 修正：角色知识页"摘要/待办"动作映射到 `checkpoints.list`/`checkpoints.get` 的**真实业务待办**；绑定引用缺失/过期改列为**状态诊断**（`sessions.listBindings` 对照），与业务待办分列、不互相冒充。"首版页面行为无裁剪"自此成立。
- §3.2 新增可见性行：交接摘要/待办是角色显式写入的交接产物，owner 全文可见；其引用的 private/role 文档正文本体仍按矩阵隐藏（引用+哈希可给，正文不附）。
- G0 范围不变：只定契约，不提前实现 G5。

### 复验状态

R02/R04 维持关闭记录。本轮回归：`probe-contract + shell-contract` 单测、探针真实窗口 E2E、shell E2E 5 场景、`npm run check` 全绿（证据 `evidence/2026-10-26-p6-g01-rework/`）。状态保持**待独立验收（第二次返工完成，再次提请复验）**。
