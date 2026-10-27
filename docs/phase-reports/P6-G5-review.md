# P6-G5 独立验收报告：知识、历史、候选与迁移

日期：2026-10-28。结论：**REWORK**（一项返工项 R1，见 §5；其余验收条件全部满足。R1 修复后按 §5.7 复验，不必重验本报告已 PASS 的全部范围）。

依据：AGENTS.md（硬性约束）、prompts/REVIEW.md、prompts/COMMON.md、prompts/06G5-knowledge.md、[P6-G5-development.md](P6-G5-development.md)（开发声明仅作线索，不作结论）、[P6-G5-plan.md](P6-G5-plan.md)（范围裁定留档）、[desktop-gui-contract.md v8 §2.2/§2.3/§3/§4/§5](../spec/desktop-gui-contract.md)、[DESKTOP_GUI_PLAN.md §13](../DESKTOP_GUI_PLAN.md)、前序 [P6-G4-review.md](P6-G4-review.md)（§6.4 "材料待采"跟进义务）。本轮止于验收：未修改产品实现、契约或开发报告，未做任何 commit/合并/发布。

## 1. 验收基线

- HEAD：`5878c38a2273e8c1f831d574b6e964e05718b711`（main；G5 三个 feat 提交 + 契约 v8/开发报告/证据 + 一条 pipeline 日志）。
- 工作区：验收开始与结束时**均干净**（`git status --porcelain` 零行）；本轮全部测试运行未翻动 `evidence/2026-10-27-p6-g3/real-session/user-data` 下的 Chromium 缓存，无需还原。
- 运行时：Node v22.23.2（`.nvmrc`，engine-strict）。
- 本阶段 diff（`d38b42d..HEAD`）：28 个文件、+1908 行，与开发报告 §2 声明的源码范围一致；`knowledge/transfer.ts`（导出/导入核心）为 P2/P5 既有实现，本阶段未改（git log 证实），G5 只是接线。

## 2. 独立运行的验证命令与退出码

| 命令 | 独立结果 | 退出码 |
| --- | --- | --- |
| `nvm use` + `node --version` | v22.23.2 | 0 |
| `npm run check`（typecheck 全量 + build + vitest 全套） | **543/543 PASS（57 文件，266s）**，含 no-business-roles 72 项、G5 core 6 项、G5 service 2 项、shell-contract G5 词汇表 | **0** |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts`（仓库根） | **14/14 PASS（57.0s）**：G1×6 + G2×5 + G3×1 + G4×1 + **G5×1 全链**，无跳过 | **0** |
| 验收方独立探测脚本 `/tmp/g5-review/independent-check.mjs`（reviewer 临时材料，直接驱动 dist 的 WorkspaceAdmin/transfer，**33 项断言**） | 33/33 PASS | 0 |
| 验收方 redact 探针 `/tmp/g5-review/redact-probe.mjs`（shell 构建产物 `redact()` 实测） | 实证 R1（§5） | 0 |
| `git status`（验收结束） | 干净 | 0 |

抽查证据目录 `docs/phase-reports/evidence/2026-10-28-p6-g5/automated/`：`gui-01-knowledge-page.png`（知识页全貌：目录含未发布声明文档、阅读器正文+哈希标注、本地草稿区、checkpoint 区、候选全文与来源/基线标注——与代码渲染路径逐项相符）、`shell-e2e-g5.log`（14/14 采集运行）。开发报告 §4 的失败/返工记录（core 测试 manifest 字段名、service 隔离断言语义、E2E 钩子、typecheck 修正）如实披露，未发现隐瞒。

## 3. 逐条验收条件核对（06G5 工作项 → 实际代码/行为/测试）

| 提示词工作项 | 核对结果 | 关键位置/证据 |
| --- | --- | --- |
| 1. 按已定可见性提供 owner 文档/修订/候选读模型；正文经服务按需读取，渲染层不读对象路径或开库 | **PASS**。六个只读投影（`documents.list`/`documents.read`(owner)/`documents.listRevisions`/`documents.listCandidates`/`checkpoints.list`/`checkpoints.get`）实现于 WorkspaceAdmin，全部纯 SELECT；验收方独立脚本对发布/提议/checkpoint 后的工作空间连续调用 9 次投影，**23 张表 digest 逐字节不变**。渲染层 `grep node:fs|node:path|require(|process.` 零命中；正文只能经 `knowledge:readDocument` 服务调用按需到达 | `packages/core/src/admin.ts:228-434`、`packages/service/src/index.ts:183-218`（六操作传输边界 Schema 校验输出，fail-closed INTERNAL）、`packages/desktop/src/shell/renderer/pages/knowledge.ts`（无 fs/path）、独立探测脚本第 1 组 |
| 2. 文档目录、历史比较、来源/可见性、checkpoint 摘要/待办、候选基线与冲突、导出/导入原生选择和结果清单 | **PASS**（正文保真受 R1 影响，见 §5）。目录含未发布声明文档（latest_revision=0+包声明可见性）；两修订并排比较+哈希标注；私密修订在下拉中标注"（私密）"；checkpoint 摘要（format+content_hash+待办概览）→详情（交接摘要全文、全部待办、来源、决策引用）；候选显示来源/原始基线→当前最新/冲突标记/正文全文/备注；导出经 main 原生对话框复制到用户所选目录、导入原生对话框选包后显示"已创建 N 个候选"清单。E2E 全链实证（目录 r1→正文→候选→导出落盘 manifest.json→导入建候选） | `knowledge.ts:114-228`、`workspace-controller.ts:242-280`、`g5.e2e.spec.ts:119-154`、截图 gui-01 |
| 3. 编辑保留本地草稿；owner 候选提议的裁定；导入只创建候选 | **PASS**。草稿仅 `window.localStorage`（键 `roledock-draft:<role>:<doc>`），界面明示"保存只写入本机浏览器存储，不经服务、不是知识、不会产生候选"；`proposals.submit` 未实施裁定**合法**（§6 评估）；导入只建候选（`importKnowledge` 事务内仅 INSERT candidate_updates，`document_revisions` 计数为 0——core 测试+独立脚本+E2E 三重实证）；页面无空功能按钮（词汇表测试锁定 knowledge 命名空间恰为 8 方法，无 submit/publish/adopt：`shell-contract.test.ts:42-49`） | `knowledge.ts:17-29,132`、`transfer.ts:186-末尾`、`g5.e2e.spec.ts:144-154` |
| 4. 验证撤权、历史不可变、过期基线冲突不丢正文、私密范围、哈希来源和目录边界；不自动合并/不迁移凭据 | **PASS**（哈希来源的 core 层成立、GUI 呈现层被 R1 破坏）。① 历史不可变：修订列表纯元数据（`JSON.stringify(page)` 不含正文串，core 测试），同 revision 不可重写由既有 CAS 承载；② 过期基线：r1 提议→发布 r2→候选 body 原样保留、`baseline_conflicted=true`（**存储 state 仍 open**，独立脚本直读库证实显示层派生）；③ 撤权：owner 读模型不依赖会话授权（读不产生权），会话面经既有 `canRead` 身份可见性门控（`documents/service.ts:79-110`），GUI 知识页无任何写通道可"继续操作"；④ 私密范围：private/role 仅元数据+哈希，正文串不出现在任何响应（core 测试+独立脚本对 read/revisions/list 逐一断言）；⑤ 哈希来源：core 读出即验 `bodyHash(body)===content_hash`，验收方以**篡改内容寻址对象文件**实证 fail-closed（抛 INTERNAL 且消息不含原文）——此项为产品测试未直接覆盖、验收方补测；⑥ 目录边界：role 过滤、未安装角色空目录不抛、未发布 read 报 NOT_FOUND；⑦ 导出 scope=share 仅 project/public 已发布条目（manifest 不含 role 文档与正文、不含 checkpoint），导入侧 private/role 条目按 `visibility_not_shareable` 跳过、篡改包被哈希校验拒绝（不碰 DB）；无凭据/宿主聊天通道 | `admin.ts:301-334,352-377,391-434`、`transfer.ts:54-63,100-115,186+`、独立探测脚本第 2-7 组 |

**退出条件**（06G5）："GUI 可查看/比较/迁移知识，并在外部角色显式发布后显示确切新修订；草稿、候选与发布清楚区分。不做向量检索、富文本协同或静默角色升级"——达成。E2E 步骤 2-3 实证发布链：原会话 Agent `sessions.anchor`（active，generation 1）→ `documents.publish` r1 → GUI 知识页经 2s 有界轮询出现 r1 正文与哈希（`g5.e2e.spec.ts:100-128`）；草稿（本地存储+明示标注）/候选（待审、显示基线）/发布（仅原会话，GUI 仅观察与指引）三者在页面文案、数据来源与词汇表三层分离；未做向量检索/富文本/静默升级。

## 4. 重点独立核查结果（验收方亲测，非仅测试绿）

1. **投影纯只读**：见 §3 工作项 1——23 张表 digest 前后逐字节相同（9 次调用覆盖全部六投影+分页翻页）。
2. **分页边界真实生效**：`limit` 0/201/-5/1.5/"10"（字符串）全部 `VALIDATION_FAILED`；limit=1 经 cursor 走完整目录与 limit=200 单页集合相等；非法 cursor（非 base64）拒绝。core 与 service 边界双层校验一致。
3. **§3.2 可见性矩阵**：project/public 才 `body_included:true`；private/role 的正文串不出现在 read/revisions/list 任何响应的序列化输出（含目录的 `body` 字段整体不存在的断言）；**候选正文全文附带且基线正文不搭载**（候选列表仅含 proposed body，无 baseline body 字段）；checkpoint 摘要仅 format+content_hash（列表序列化不含摘要正文）、详情有全文+读出验哈希。
4. **同名 documents 操作双 dispatch 隔离**：session principal 在 `service/index.ts:99` 直接转 `connection.call`（会话自有 `documents.list/read`，经 MCP binding 可见性），**不进入** owner 分支；owner 六操作走 `#admin` 投影，互不借用身份。service 测试断言：trusted 主体六操作全 `PERMISSION_DENIED`；会话面 owner-only 四视图（listRevisions/listCandidates/checkpoints.*）全拒、会话自有 documents.list/read 保留。
5. **渲染层边界**：`knowledge:` 是封闭命名空间（8 方法）；export/import 的文件解析在受信 main 进程（原生对话框或文档化测试夹具 env），`knowledge:export` 无通用路径入参（仅 scope/role_id）、`knowledge:import` noPayload；渲染层只拿摘要/`saved_to` 标签与候选清单；8 条 handler 均 assertTrusted+redact+输入校验。E2E 断言渲染层无 `process`/`require`（G1 既有，清单更新后仍通过）。
6. **导出导入迁移语义**：share 包仅 project/public 已发布 latest（JOIN documents.latest_revision），写包时哈希重算复核；导入先验全部条目哈希（篡改不碰 DB）、private/role 与未安装角色/未声明文档键逐项跳过、目标工作空间 `document_revisions` 计数 0、目录全部 latest_revision=0、候选 source=knowledge.import 且正文全文——"两个工作空间迁移后是候选而非静默发布"实证。
7. **GUI 发布后新修订自然出现**：E2E 步骤 2-3（锚定→发布→2s 轮询出现 r1），轮询有界（hidden 暂停、hashchange 清理监听）。

## 5. 返工项

### R1（高）：知识正文经 shell IPC `redact()` 被静默改写，破坏"正文即 content_hash 对应字节"的保真声明

- **触发条件**：已发布文档正文（public/project 的 `body`）、候选正文（`body`）、交接摘要正文（`handoff_summary.body`）、待办描述（`todos[].description`）或候选备注（`note`）中含**标注型秘密形态**字符串——如 `Bearer <≥12字符>`、`token: <值>`、`password: <值>`、`api_key: <值>`。此类内容在工作文档（事故记录、密钥轮换记录、配置示例）中并不罕见。
- **位置**：
  - `packages/desktop/src/shell/main/ipc.ts:262`——所有 shell handler 回复统一 `redact(...)`；
  - `packages/desktop/src/shell/shared/redact.ts`——`FREE_TEXT_FIELD` 正则含 `body`，对象分支对具名字符串强制 `scrubDisplayText()`；
  - `packages/desktop/src/shell/renderer/pages/knowledge.ts:141`（阅读器标注"内容哈希 `<hash>`（正文即该哈希对应字节）"）、`:200`（checkpoint 详情同标注）、`:161`（比较的"正文相同/不同"判定基于 scrub 后文本）。
- **影响**：违反 desktop-gui-contract §3.1 第 4 层定档（"经脱敏/截断的显示文本**不得**标注为与某 `content_hash` 对应的字节"）与 §2.3 `documents.read`"content_hash（**原始字节**）"、§3.2"全文"语义。service 传输边界的 Schema 校验发生在 service 进程（校验原文、通过），scrub 发生在其后的 desktop IPC 层——**静默失真、无任何告警**：owner 在 GUI 复核哈希将失败且无从知道原因；两版比较可能因正文仅差秘密片段而误报"正文相同"。哈希来源是 06G5 工作项 4 的明确验证项，其 core 层实现正确（§3/§4），但在 GUI 呈现链上被破坏。注：候选 `note`、`todos[].description` 自身无哈希配对，其 scrub 属契约 §3.1 第 3 层"尽力而为"允许范围，**不属缺陷**；`probe` 桥 `PROBE_METHODS` 不含 knowledge 操作，修复面仅 shell 桥。
- **实证**（验收方 redact 探针，驱动 shell 构建产物 `dist/shell/shared/redact.js`，与 ipc.ts:262 同函数同默认参数）：
  - 输入正文 `Incident log: the connector emitted \`Bearer sk-live-abcdef1234567890\` at 10:02.` → 输出 `...Bearer [masked]...`（字节改变，与 content_hash 不再对应）；
  - `handoff_summary.body` "Handoff mentions token: abcdef1234567890ab" → "token: [masked]"；`todos[].description` "rotate the api_key: zzz…" → "[masked]"。
- **修复要求**：为 knowledge 读响应中**与 content_hash 配对的正文**（`body`、`handoff_summary.body`）提供逐字节保真通道——例如利用 redact 现有 `options.freeText` 机制对相应 handler 关闭自由文本 scrub，或将正文置于非 FREE_TEXT 键名的结构中；修复须保持契约 §3.1 第 1 层投影（DTO 字段白名单）与第 2 层 SECRET_FIELD 名单不变（秘密**字段**仍不得出现），并同步核查 §3.1 第 3 层"两桥一致"注释的适用性；GUI 的"正文即该哈希对应字节"标注在保真通道建立后方可保留。
- **复验方法**：发布正文含 `Bearer abcdef1234567890` 的 project 文档，经 shell IPC `knowledge:readDocument` 读回，断言 `body` 与 `content_hash` 逐字节对应（`sha256(body)===content_hash`），并补一条同形态的回归测试进 shell 契约测试或 g5 E2E；随后重跑 `npm run check` 与 shell E2E。

## 6. `proposals.submit` 未实施裁定评估（prompt 工作项 3 / 计划 §13）

**裁定合法**，理由链：

1. 06G5 工作项 3 为条件句："**如增加** owner 候选提议，先明确独立来源和审计"——owner 提议非本阶段强制项。
2. 计划 §13 明文预留本轮不实施的出口："若本轮不实施 owner 候选提交，首版明确显示'本地草稿'，仍可通过现有导入流程提交候选，**不能出现空功能按钮**"——三个条件全部满足：草稿区明示（§3 工作项 3）、提交候选可走既有导入流程（E2E 步骤 6）、无空按钮（词汇表测试 `shell-contract.test.ts:42-49` 锁定 knowledge 命名空间恰为 8 方法且显式断言无 submit/publish/adopt）。
3. 契约 §2.3 将 `proposals.submit` 标为 G5/G6，v8 注明"本轮未实施……实施前需先明确独立来源与审计"——未占用名字、未伪装。
4. 计划留档的裁定理由**属实**（验收方独立核实）：`candidate_updates.source` 的 CHECK 约束仅 `'documents.propose','knowledge.import','request.result'` 三来源（`migrations.ts:274`），owner 提案需扩 CHECK（新迁移）+ `proposed_by` 身份语义（现 NOT NULL session/role）+ 独立审计——属架构/权限面变化，按仓库纪律须先补 ADR，不属"只读落点"范畴。
5. 退出条件不含 owner 提议；硬性约束 4（未实现不伪装）得到遵守。

## 7. G4 遗留"材料待采"承接核对

`evidence/2026-10-27-p6-g4/` 下 **FINDINGS.md 与 gui-03…gui-07 仍未补采**（目录内容与 G4 验收时一致：automated/ 两截图+日志、STEPS.md、两个采集脚本）；本阶段自身真机截图（知识页真机形态）同样待采，开发报告 §6/§8 如实声明"沿用两份 STEPS，待用户配合采集"。按 G4 验收 §6.4 的既定裁定升级为本阶段**观察项 O-A**：自动化证据覆盖同版本代码的相同代码路径，非功能缺口，不构成 REWORK/BLOCKED；**随 G7 产品证据收口（GUI-04…07 矩阵）最迟补齐**，届时若仍缺失应作为 G7 验收的实质问题处理。

## 8. 观察项（不影响本阶段结论）

- **O-A（证据冗余）**：G4/G5 真机补充证据待采——见 §7。
- **O-B（低，边界澄清）**：`redact()` 对候选 `note`、`todos[].description`、比较日志等非哈希配对自由文本的 scrub 是契约第 3 层定档行为；但修复 R1 时建议在契约 §4 的 knowledge 行补一句"哈希配对正文逐字节保真、不适用自由文本 scrub"，把 R1 的修复固化进契约，避免后续阶段再次踩线。
- **O-C（低，显示细节）**：分页 UI 未做翻页控件（目录 limit=200、候选 100、checkpoint 50 单页渲染），与 G4 O-C 同性质；core/service 分页契约已实现并验证，条目规模为文档/checkpoint 数量级。
- **O-D（记录）**：比较为并排显示+哈希对照，非逐字 diff——计划 §13 允许"轻量"，开发报告 §8 如实披露；R1 修复前"正文相同"判定基于 scrub 后文本（并入 R1 复验）。

## 9. 测试真实性总评

各层测试均有行为断言而非逐字复述实现：core 断言序列化输出不含正文串、存储计数（`document_revisions` n=0）、边界拒绝与翻页；service 断言传输边界输入拒绝与三面互拒；E2E 用真实 Electron+真实服务+真实 MCP stdio 客户端完成锚定→发布→观察→导出→导入全链，零模型轮 mock 宿主如实标注。开发报告声明的数字（543/543、14/14、6/6、2/2）与验收方独立运行一致。验收方另补三类产品测试未覆盖的检查：投影只读的存储级前后对比、内容寻址对象篡改的 fail-closed、IPC redact 对正文的改写（后者即 R1 发现手段）。

## 10. 范围限制

- 未独立重跑真机步骤（需真实 ZCode 桌面会话与用户配合）——按 §7 裁定待采。
- 未重跑 `npm run desktop:e2e`（probe 回归）；shell IPC 边界随 14 项 shell E2E 覆盖。
- 未复跑开发侧证据采集运行（`automated/shell-e2e-g5.log` 为开发侧采集）；以验收方自身 14/14 运行与截图内容核对替代。
- 验收方临时材料位于 `/tmp/g5-review/`（independent-check.mjs、redact-probe.mjs、debug-readonly.mjs），不入库、不影响工作区（验收结束工作区干净）。

**P6-G5 结论：REWORK**——完成 R1（知识正文 IPC 保真）修复与复验后，本阶段其余范围即成立，可进入 G6；R1 不要求重验本报告已 PASS 的 core/service 投影语义与导出导入迁移语义。本轮不自动开始修复、不提交、不发布；本报告不授予合并或发布权限。
