# P6-G5 开发报告:知识、历史、候选与迁移

日期:2026-10-28。状态:**待独立验收**。

基线:HEAD `d38b42d`(G0–G4 与 G4 验收报告已提交)上叠加本阶段变更。前置 **P6-G4 已独立验收 PASS**(`P6-G4-review.md`;其"材料待采"的真机补充证据随本阶段跟进,见 §8)。实施计划已留档:`P6-G5-plan.md`(用户预授权免审批)。

## 1. 范围裁定(与计划一致)

- **实施 6 个 owner 只读投影**:`documents.list`、`documents.read`(owner 版)、`documents.listRevisions`、`documents.listCandidates`、`checkpoints.list`、`checkpoints.get`——契约 §2.3 已定档行,全部纯投影,无状态机改动,**无迁移**。
- **不实施 `proposals.submit`**(契约标 G5/G6):owner 提议需 candidate 来源扩 CHECK 与 proposed_by 身份语义变化,属架构/权限面。按计划 §13 替代路径:编辑器**本地草稿**(localStorage,明确标注"本地草稿,未提交"),提交候选走既有 `knowledge.import`(来源 knowledge.import,审计已有);页面无空功能按钮(词汇表测试锁定无 submit/publish/adopt)。
- 正式发布/采纳不做:GUI 明示"由当前主角色在原会话显式完成";发布后新修订经有界轮询自然出现(E2E 实证)。
- 不做:向量检索、富文本协同、静默角色升级、自动合并导出文件、迁移凭据/私人聊天。

## 2. 源码变化

**协议层 `packages/protocol`**
- `src/types.ts`:新增 `OwnerDocumentEntry/ListPage`、`OwnerDocumentRead`、`OwnerDocumentRevisionEntry/RevisionsPage`、`OwnerCandidateEntry/CandidatesPage`、`OwnerCheckpointSummary/ListPage`、`OwnerCheckpointDetail`。
- 6 个新 Schema(`owner-documents`/`owner-document`/`owner-document-revisions`/`owner-candidates`/`owner-checkpoints`/`owner-checkpoint-detail`,全部 `additionalProperties:false`);`service-control-operation` 增加 6 个输入分支;`validate.ts` 注册。

**核心层 `packages/core/src/admin.ts`**(WorkspaceAdmin,owner 读模型既有归属)
- 六个只读方法:目录(声明∪注册表合并,未发布文档 latest_revision=0+包声明可见性)、按需正文读(visibility ∈ {project,public} 才附 body,private/role 仅元数据+哈希,读出即验 `bodyHash`)、修订历史(元数据)、候选(候选正文**全文**附带并验哈希;`baseline_conflicted` 为显示层派生标记)、checkpoint 摘要(handoff_summary 仅 format+content_hash)与详情(摘要正文全文+验哈希、todos/sources/决策引用)。
- 分页:`limit` 1–200 默认 50,offset 游标(base64,沿用 `policy.list` 先例);全部投影只读。

**服务层 `packages/service/src/index.ts`**
- owner 面注册六操作,传输边界 Schema 校验;trusted 主体一律 `PERMISSION_DENIED`。**owner 面与会话面同名 `documents.list/read` 是不同 dispatch 路径**(owner=WorkspaceAdmin 投影,session=Coordinator 会话工具),互不借用身份;会话面自有工具不变。

**桌面 `packages/desktop`**
- `contract.ts`:新封闭命名空间 `knowledge:` = listDocuments/readDocument/listRevisions/listCandidates/listCheckpoints/getCheckpoint/export/import。
- `workspace-controller.ts`:六读代理 + `knowledgeExport`(owner RPC `knowledge.export` 产包到 `.roledock/exports/` 后,由 main 经原生对话框复制到用户所选目录;测试夹具 `ROLEDOCK_SHELL_EXPORT_FIXTURE`)+ `knowledgeImport`(原生对话框选包目录 → `knowledge.import` → 返回候选清单;夹具 `ROLEDOCK_SHELL_IMPORT_FIXTURE`)。渲染层不经手对象路径。
- `ipc.ts`:8 条新 handler(assertTrusted + redact + 输入校验;export 无通用路径入参)。
- `renderer`:导航新增"角色知识";新页 `#/knowledge`(目录/阅读器(私密文档显示"仅元数据+哈希")/两修订并排比较+哈希标注/checkpoint 摘要→详情(交接摘要全文、全部待办、来源)/候选(来源、原始基线 vs 当前最新、基线过期标记、正文全文)/本地草稿编辑器/导出导入结果清单);有界轮询 2s + hidden 暂停 + observed_at。

## 3. 契约与文档

- `desktop-gui-contract.md` **v8**:六操作标"G5 已实现"并注 Schema 名;§2.2 各行标注 + `proposals.submit` 未实施说明;§4 补 `knowledge:` 命名空间。
- 无依赖变动、无 ADR(纯既定契约的只读落点;owner 提议若未来实施须先补 ADR——已在计划留档)。

## 4. 验证(全部真实运行)

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| 分步 `tsc -b`(protocol/core/service/desktop) | 全部通过 | 0 |
| `npx vitest run packages/core/test/g5-knowledge.test.ts` | 6/6 PASS | 0 |
| `npx vitest run packages/service/test/g5-knowledge.test.ts` | 2/2 PASS | 0 |
| `npm run check` | **543/543 PASS(57 文件)** | 0 |
| shell E2E(带证据目录) | **14/14 PASS**(原 13 项 + g5 全链) | 0 |

失败/返工记录(均已修复复跑):① core 测试 manifest 条目字段为 `owner_role_id` 而非 `role_id`;② service 测试角色包路径(改 `resolve("examples/demo-team")`)与隔离断言语义(会话面对 `documents.list/read` 本就是会话自有工具,隔离断言改为"受信面六操作全拒 + 会话面 owner-only 四视图全拒");③ E2E 截图钩子作用域(同 G4 教训)与 G1 清单断言加 `knowledge`;④ typecheck 发现 E2E MCP 回复类型缺 `authorizations` 字段。

## 5. 验证项对照(06G5 工作项 4 / 计划 §13 验证段)

- **历史不可变**:修订列表纯元数据,同一 revision 不可重写(CAS 既有);core 测试断言列表输出不含正文。
- **过期基线冲突不丢正文**:candidate 在 r1 提议 → 发布 r2 → 候选 body 原样保留、`baseline_conflicted=true`、state 仍 open(core+GUI 显示)。
- **撤权后的旧页面**:owner 读模型不依赖授权(读不产生权);会话面操作受 `requireBindingCapability` 约束(既有,G3/G4 已验收);GUI 明示发布/采纳须原会话有权角色。
- **私密范围**:role/private 文档 `body_included:false` + 哈希;core 测试断言正文串不出现在任何响应。
- **哈希来源**:正文读出即验 `bodyHash(body)===content_hash`,不符即 INTERNAL(候选、文档、交接摘要同律)。
- **目录边界**:role_id 过滤;未安装角色目录为空;未发布声明文档如实显示"未发布"。
- **导出包无凭据/私人聊天**:`export scope=share` 仅 project/public 已发布条目(core 测试断言 secrets 不在 manifest);导出默认 share。
- **两个工作空间迁移后是候选**:导入只建候选,目标工作空间 `document_revisions` 计数为 0、目录全部 latest_revision=0(core 测试实证)。

## 6. 证据

`docs/phase-reports/evidence/2026-10-28-p6-g5/automated/`:`gui-01-knowledge-page.png`(知识页全貌:目录/阅读器正文+哈希/候选全文/导入导出区)、`shell-e2e-g5.log`(14/14 运行日志)。真机补充证据(含 G4 遗留 gui-03…07)沿用两份 STEPS,待用户配合采集。

## 7. 退出条件自查(06G5)

- GUI 可查看/比较/迁移知识:目录、按需正文(含私密边界)、两版比较、导出导入——E2E 全链实证。
- 外部角色显式发布后显示确切新修订:锚定→发布→目录 r1 出现(E2E 步骤 2–3)。
- 草稿、候选与发布清楚区分:草稿=本地存储且明确标注;候选=待审、显示基线;发布=仅原会话,GUI 只有观察与指引。
- 不做向量检索/富文本协同/静默角色升级(未做);无空功能按钮(词汇表锁定)。

## 8. 遗留与风险

1. **真机补充证据待采**(G4 gui-03…07 + 本阶段知识页真机截图):STEPS 已固化,自动化证据覆盖同代码路径;非功能缺口。
2. `proposals.submit` 未实施(计划裁定);若验收方认为 G5 必须含 owner 提议,需先补 ADR 与迁移,工作量另计。
3. checkpoint 列表在长历史工作空间按 created_at 倒序分页(offset 游标),与 policy.list 先例一致;超大历史(>200)需翻页,GUI 当前单页 limit=50/100,条目规模为 checkpoint 数量级。
4. 比较为并排显示+哈希对照,非逐字 diff(计划允许"轻量";未做富文本)。

## 8a. 复审返工 R1(2026-10-28 补记)

首次独立验收结论 REWORK(`P6-G5-review.md`,唯一返工项 R1):IPC redact 的自由文本掩盖误伤哈希配对正文。修复与复验见 `P6-G5-rework.md`(redact 双桥加 `body` 逐字节保真例外 + 契约 v8 §4 补记 + 回归测试;`npm run check` 545/545、shell E2E 14/14 全绿)。验收观察 O-A(真机证据随 G7 收口)、O-C(分页翻页控件)、O-D(并排比较非逐字 diff)不阻塞。

## 9. 停止点

本阶段完成即停止:不进入 G6、不推送远程。按既有批次风格提交本阶段变更(不推送),交独立验收 Agent 按 `prompts/REVIEW.md` 形成 `P6-G5-review.md`。
