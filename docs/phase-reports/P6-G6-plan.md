# P6-G6 实施计划:请求、产物与收件箱(留档)

日期:2026-10-28。状态:**计划定稿,按用户预授权实施,不设审批等待**。
前置:P6-G5 已收口(验收 REWORK→R1 修复复验,`P6-G5-rework.md`;验收方完成标准已满足)。
依据:`prompts/06G6-requests-and-inbox.md`、`docs/DESKTOP_GUI_PLAN.md` §14、`desktop-gui-contract.md` §2.3 G6 行、§5 幂等、§6 cancelByOwner 逐状态矩阵、ADR-0013。

## 0. 范围裁定

- **owner 有界读视图 4 个**:`requests.listInbox`(分页,按 state/role 过滤;条目含 initiating/target、state、`execution_uncertain`/`cleanup_pending`、binding{generation,knowledge_revision}、budget、**已报告用量——缺失显示 unknown 不冒充 0**、result 摘要 artifact_id/content_hash)、`requests.get`(owner 版完整详情,question 含澄清追加历史)、`artifacts.read`(owner 版:body 原始字节+content_hash+producing_role_id+request_id,读不产生写权)、`requests.listCleanup`(回收视图:终态 request_id、state、`cleanup_pending`、**`cleanup_error`**——回收失败与完成可区分)。
- **owner 管理取消 `requests.cancelByOwner`**:§6 逐状态矩阵原样落点(accepted/queued/awaiting_input→cancelled;running 仅当适配器声明 cancel 能力否则 `REQUEST_NOT_TERMINABLE` 且状态不变;终态拒绝);**幂等键**(§5:同键重放返回首次结果+`idempotent_replay:true`,同键不同输入 `IDEMPOTENCY_CONFLICT`,不同键对终态拒绝);独立审计 outbox 事件 kind=`owner.request.cancel`;**不借发起 session 身份**。补充回复仍由原发起会话 `requests.reply` 执行,GUI 不自建聊天。
- **session 面新工具 `inbox.list`**:角色会话查询**自己的**收件箱(按 binding 的 role_id 过滤,unread/read 维度,条目状态);只读。经 anchor.ts sessionCall map 落点 + MCP 工具 `inbox_list`;普通会话无 owner 操作的边界不变。
- **迁移 9**:`requests.cleanup_error_json` 列(cleanupRequest 失败时写入、成功清空)——契约 listCleanup 要求回收失败可区分,现有实现失败静默重试无记录;不改任何状态机语义。
- **不做**:任务 DAG、嵌套自动请求、后台向主聊天注入、GUI 自建聊天、GUI 直接 publish(采纳指引:回原会话由主角色 `documents.publish(adopt_artifact_id)`);已知缺失用量不以 0 冒充。

## 1. Protocol 层

- 新类型:`OwnerRequestInboxPage`(item:OwnerRequestSummary)、`OwnerRequestDetail`(含 question 全文/预算/用量/result/error)、`OwnerArtifactRead`、`OwnerCleanupPage`、`OwnerCancelResult`(public request + `idempotent_replay` 标记);用量投影 `{ output_bytes: number|null, turns_reserved: number|null }`(null=未知,未开始执行即 null)。
- 5 个新 Schema(`owner-requests`/`owner-request-detail`/`owner-artifact`/`owner-cleanup`/`owner-cancel-result`)+ `service-control-operation` 5 个分支(requests.listInbox/requests.get/requests.cancelByOwner/requests.listCleanup/artifacts.read)。

## 2. Core 层

- `packages/core/src/admin.ts`(owner 读模型既有归属):`requestInbox`(分页+state/target_role 过滤,基于 `listRequests`/`toPublicRequest` 复用)、`requestGet`、`artifactRead`(复用 readArtifact 的哈希验证逻辑,去 session 参与者校验)、`cleanupList`。迁移 9 列进 row 读取。
- `packages/core/src/requests/service.ts`:新增 `cancelByOwner(store, adapterCancelDeclared, input)`——状态矩阵+幂等键(复用 `idempotency_keys` 表:target_kind='request.cancel',target_id=request_id,content_hash=输入哈希;重放从请求行重建首次结果)+ outbox 审计事件。`executor.ts` 的 `cleanupRequest` 成功清空/失败写入 `cleanup_error_json`。
- `packages/core/src/sessions/anchor.ts`:sessionCall map 增加 `"inbox.list"`(required [],optional ["unread_only"])→ 新 coordinator 方法 `listSessionInbox`(以 binding role_id 过滤 `listInboxEntries`,返回条目+request 摘要)。

## 3. Service 层

- owner 面注册 5 操作(传输边界 Schema 校验);trusted/session 主体拒绝。
- MCP(`packages/mcp`):工具清单加 `inbox_list`(operation inbox.list)。

## 4. 桌面层

- `contract.ts`:新封闭命名空间 `inbox:` = listRequests/getRequest/readArtifact/listCleanup/cancelRequest;重导出类型。
- `ipc.ts`/`workspace-controller.ts`:代理 + 分页/键校验;取消走确认流(先展示当前状态与不可取消原因,再显式取消)。
- 渲染层 `#/inbox` 页(导航"请求收件箱"):列表(state/角色筛选、用量 unknown 显示"未知"、execution_uncertain/cleanup_pending 标记)→ 详情(question 全文、binding 快照、预算、result)→ 产物查看(正文+哈希)→ 管理取消(状态守卫:running 且无 cancel 能力显示"不可取消(适配器未声明)"并禁用)→ 回收视图(cleanup_pending 与 cleanup_error 分列)→ 采纳指引("建议采纳:回原会话由当前主角色 documents.publish(adopt_artifact_id=<id>)";候选/请求结果采纳后显示 adopted 与确切修订——候选状态经 G5 candidates 视图对照)。completed、已读(inbox)、adopted 三维度分列。有界轮询同 G4/G5。

## 5. 测试与验证(对照 06G5/06G6 工作项 5 与计划 §14 验证段)

- core 单测:cancelByOwner 逐状态矩阵(含 running 无能力拒绝且状态不变、终态不同键拒绝、同键重放 `idempotent_replay`、同键不同输入 IDEMPOTENCY_CONFLICT)、审计事件写入、cleanup_error 写入/清空、owner 读投影(用量 unknown、过期惰性失效)、inbox.list 仅本角色。
- service 单测:主体隔离(session/trusted 五操作全拒)、边界校验、MCP inbox_list 经会话凭据可用。
- shell E2E `g6.e2e.spec.ts`:锚定两会话(发起/目标)→ 发起请求 → GUI 收件箱列表/详情/产物 → 管理取消(accepted→cancelled,cleanup 视图)→ 重新请求运行完成 → artifacts 正文/哈希 → 采纳指引显示。
- 全量 `npm run check` + shell E2E 全绿。

## 6. 文档与收尾

- 契约 v9:G6 行标"已实现";§4 补 `inbox:` 命名空间与 MCP inbox_list。
- `P6-G6-development.md`(待独立验收)+ 证据目录;分批提交(不推送);停止点:不进入 G7(由流水线下一步处理)。
