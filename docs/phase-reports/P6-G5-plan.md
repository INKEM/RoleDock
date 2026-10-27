# P6-G5 实施计划:知识、历史、候选与迁移(留档)

日期:2026-10-28。状态:**计划定稿,按用户预授权实施,不设审批等待**。
前置:P6-G4 独立验收(进行中,PASS 后进入实施;REWORK 先返工;BLOCKED 报告用户)。
依据:`prompts/06G5-knowledge.md`、`docs/DESKTOP_GUI_PLAN.md` §13、`docs/spec/desktop-gui-contract.md` §2.3 G5 行、§3 可见性矩阵、§5 幂等规则、ADR-0013。

## 0. 范围裁定(实现前定档)

- **实施 6 个 owner 只读投影**:`documents.list`、`documents.read`(owner 版)、`documents.listRevisions`、`documents.listCandidates`、`checkpoints.list`、`checkpoints.get`——均为契约 §2.3 已定档行,数据已存在(documents/document_revisions/candidate_updates/checkpoints 表),无状态机改动,**无迁移**。
- **不实施 `proposals.submit`(契约标注 G5/G6)**:owner 提议需要 candidate_updates 来源扩 CHECK(owner 提案)+ proposed_by 身份语义(现 NOT NULL session/role)+ 独立审计,属架构/权限面变化。按计划 §13 明示的替代路径执行:**编辑器保存本地草稿(仅渲染层,明确标注"本地草稿,未提交");提交候选走既有 owner 导入流程(knowledge.import,来源 knowledge.import,审计已有)**。页面不得出现空功能按钮;契约 v8 将该行标注保持"G5/G6,本轮未实施"。
- 正式发布/采纳不做:GUI 显示"回原会话由当前主角色显式发布"指引;发布后新修订经轮询自然可见(退出条件)。
- 不做:向量检索、富文本协同、静默角色升级、自动合并导出文件、迁移凭据/私人聊天。

## 1. Protocol 层

- 新类型(owner 页面统一 `{workspace_id, observed_at, items, next_cursor}`):
  - `OwnerDocumentListPage`(item:role_id、document_key、latest_revision、updated_at;无正文)
  - `OwnerDocumentRead`(`{role_id, document_key, revision?, body_included, body?, content_hash, visibility, created_at}`;private/role → `body_included:false` 只给元数据+哈希)
  - `OwnerDocumentRevisionsPage`(item:revision、content_hash、visibility、created_by_instance_id、created_at)
  - `OwnerCandidatesPage`(item:candidate_id、target_role_id、document_key、candidate_body 全文、note、baseline_revision、当前 latest_revision、`baseline_conflicted` 派生标记、source、state、created_at)
  - `OwnerCheckpointListPage`(item:checkpoint_id、role_id、generation、knowledge_revision、document_snapshots 摘要、created_at、handoff_summary 元数据 format/content_hash、todos 概览 total/done+未完成 description)
  - `OwnerCheckpointDetail`(get:handoff_summary.body 全文+content_hash、todos 全量、sources、user_decision_refs、document_snapshots)
- 6 个 draft 2020-12 Schema(`owner-documents`/`owner-document`/`owner-document-revisions`/`owner-candidates`/`owner-checkpoints`/`owner-checkpoint-detail`)注册 + `service-control-operation` 六个输入分支。
- 脱敏:候选正文/发布正文全文(§3.2 矩阵);private/role 基线正文不出现(仅哈希);handoff_summary/todos/sources 全文。

## 2. Core 层(`packages/core/src/admin.ts`,WorkspaceAdmin 扩展)

- 六个只读方法,分页/游标与 `policy.list`/`listConfirmations` 同律(cursor=`created_at|id` base64url,limit 1–200 默认 50);**投影只读**。
- `documents.read`(owner):按 §3.2 矩阵决定 body 是否附带;content_hash 对原始字节;body 从 objects 存储按需读取,不经渲染层。
- candidates 的 `baseline_conflicted` = proposed baseline < 当前 latest_revision(过期基线显示,不丢正文,不自动合并)。

## 3. Service 层(`packages/service/src/index.ts`)

- owner 面注册六操作,传输边界 Schema 校验(照 `roles.get` 样板);trusted/session 主体 `PERMISSION_DENIED`。注意 owner 面 `documents.list/read` 与会话面同名操作是**不同 dispatch 路径**,owner 版不借用 session 身份。

## 4. 桌面 main(`packages/desktop/src/shell/`)

- `contract.ts`:新封闭命名空间 `knowledge:` = `listDocuments/readDocument/listRevisions/listCandidates/listCheckpoints/getCheckpoint/export/import`;重导出 G5 类型。
- `ipc.ts`/`workspace-controller.ts`:七代理 + 导出/导入的原生对话框(save/open),对话框支持测试夹具 env(沿用 `ROLEDOCK_SHELL_DIALOG_FIXTURE` 先例);导出内容 = `knowledge.export` 返回结构写 JSON 文件,导入文件内容喂 `knowledge.import`,结果清单(创建的候选列表)回渲染层。
- assertTrusted + redact + 无参拒 payload 纪律不变。

## 5. 渲染层(#/knowledge 新页,导航新增"角色知识")

- 角色选择 → 文档目录 → 正文阅读器(body_included:false 时显示"私密范围,仅元数据+哈希"+哈希)。
- 历史比较:选两修订并排显示 + content_hash 标注(轻量,无富文本)。
- Checkpoints:摘要列表 → 详情(交接摘要全文、todos 全量、来源);与绑定健康诊断(授权确认页)分列,互不冒充。
- 候选:列表(来源/原始基线/当前基线/冲突标记/正文全文);过期基线冲突显式显示,不自动合并。
- 编辑器:textarea 草稿,localStorage 按 role+document_key 存取,界面明确"本地草稿,未提交;提交候选请使用导入";导入流程产生候选后显示"已创建候选"清单。
- 轮询纪律同 G4(2s 有界、hidden 暂停、observed_at 守卫);发布后新修订自然出现。

## 6. 测试与验证(对照 prompt 工作项 4 / 计划 §13 验证段)

- core/service 单测:目录边界(按 role 过滤)、历史不可变(同 revision 重写拒绝)、过期基线候选正文保留、private/role body_included、候选/摘要/详情哈希保真、跨工作空间导入产生候选而非发布、导出结构无凭据/宿主聊天标记、主体隔离(session/trusted 拒绝六操作)。
- shell E2E `g5.e2e.spec.ts`(mock,零模型轮外的既有 g4 链路复用):锚定→发布文档→GUI 知识页目录/正文/修订可见→导入创建候选→导出文件落盘→候选基线冲突显示;导出/导入走对话框夹具。
- 全量 `npm run check` + shell E2E 全绿。

## 7. 文档与收尾

- 契约 v8:六操作标"G5 已实现";`proposals.submit` 保持未实施并注明替代路径;§4 清单补 `knowledge:` 命名空间。
- `docs/phase-reports/P6-G5-development.md`(待独立验收)+ 证据 `evidence/<日期>-p6-g5/`(automated 截图/日志 + E2E);无依赖变动、无 ADR(无架构/权限变化;owner 提议若未来实施需先补 ADR——已在裁定中说明)。
- 停止点:完成后停止,不 commit、不进入 G6。
