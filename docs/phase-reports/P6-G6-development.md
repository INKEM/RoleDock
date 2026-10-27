# P6-G6 开发报告:请求、产物与收件箱

日期:2026-10-28。状态:**待独立验收**。

基线:HEAD `5ac45ee`(G0–G5 与 G5 复审 R1 修复已提交)上叠加本阶段变更。前置 P6-G5 已收口(验收 REWORK→R1 修复复验,验收方完成标准满足,见 `P6-G5-review.md`/`P6-G5-rework.md`)。实施计划留档:`P6-G6-plan.md`(预授权免审批)。

## 1. 交付范围(对照 06G6 五项工作)

| 工作项 | 交付 |
| --- | --- |
| 1. owner 请求/产物/预算/回收详情和分页 | `requests.listInbox`(分页+state/角色过滤)、`requests.get`(全文 question 含澄清追加)、`artifacts.read`(owner 版,body 字节+哈希验证)、`requests.listCleanup`(回收视图)——全部纯投影 |
| 2. 固定会话身份的收件箱读取工具 | SDK 新操作 `inbox.list`(Coordinator `listSessionInbox`;MCP `inbox_list`,工具表 14→15):固定为调用会话自己的绑定角色,unread/read 维度,只读;操作面文档 `docs/spec/sdk-operations.md` 已更新(18→19) |
| 3. GUI 管理取消 = 独立 owner 操作与审计 | `requests.cancelByOwner`:§6 逐状态矩阵原样(accepted/queued/awaiting_input→cancelled;running 仅当适配器声明 cancel 能力否则 `REQUEST_NOT_TERMINABLE` 且状态不变;终态拒绝);§5 幂等键(同键重放 `idempotent_replay:true`、同键不同输入 `IDEMPOTENCY_CONFLICT`);独立审计 outbox 事件 `owner.request.cancel`;不借发起 session 身份 |
| 4. 结果只建议采纳 | GUI 显示"建议采纳:回原会话由当前主角色执行 `documents.publish(adopt_artifact_id=…)`";无 owner publish/adopt/reply 通道(词汇表测试锁定) |
| 5. 验证 | 见 §4/§5;用量未报告显示 unknown 不冒充 0 |

不做:任务 DAG、嵌套自动请求、后台向主聊天注入、GUI 自建聊天、静默角色升级(均未做)。

## 2. 源码变化

- **protocol**:5 类型(`OwnerRequestSummary/InboxPage`、`OwnerRequestDetail`、`OwnerArtifactRead`、`OwnerCleanupEntry/Page`、`OwnerCancelResult`)+ 5 Schema + `service-control-operation` 5 分支。
- **core**:
  - 迁移 9:`requests.cleanup_error_json`(回收失败记录、成功清空;终态不变;`executor.cleanupRequest` 同步写/清)。
  - `requests/service.ts`:`cancelByOwner`(§6 矩阵+幂等键复用 `idempotency_keys` 表 target_kind=`request.cancel`+审计事件)、`listSessionInbox`(会话自有收件箱)。
  - `admin.ts`:`requestInbox/requestGet/artifactRead/cleanupList/cancelRequestByOwner`(后者透传适配器 cancel 能力声明——owner 不能绕过)。
  - `coordinator.ts`:`listSessionInbox` 方法;`anchor.ts` sessionCall map 增 `inbox.list`。
- **service**:owner 面注册 5 操作(传输边界 Schema 校验;cancelByOwner 传 `capabilities.optional.cancel`)。
- **mcp**:`inbox_list` 工具。
- **desktop**:`inbox:` 命名空间(listRequests/getRequest/readArtifact/listCleanup/cancelRequest);`#/inbox` 页(列表/详情/产物查看/取消(必填原因+幂等键由 GUI 生成)/回收视图/采纳指引/unknown 用量显示);导航"请求收件箱"。

## 3. 契约与文档

- `desktop-gui-contract.md` **v9**:五操作标"G6 已实现";§2.2 标注;§4 补 `inbox:` 命名空间;SDK 操作面文档 +`inbox.list`。
- 无依赖变动;迁移 9 为可观测性字段(不改状态机),无 ADR。

## 4. 验证(真实运行)

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run packages/core/test/g6-requests-inbox.test.ts` | 4/4 PASS | 0 |
| `npx vitest run packages/service/test/g6-requests-inbox.test.ts` | 2/2 PASS | 0 |
| shell E2E(带证据目录) | **15/15 PASS**(原 14 项 + g6 全链) | 0 |
| `npm run check` | **553/553 PASS(59 文件)** | 0 |

失败/返工记录(均修复复跑):① `service-control-operation.schema.json` 脚本编辑产生非法 JSON(定位修复);② core 测试 setup 漏装角色包、requests.create 需 read_exception_rationale、Held 夹具下 running 取消须声明能力(§6 正确行为)、testing.ts 补导出;③ service 测试目标角色需已锚定主实例——改为双 fixture 会话双锚定,worker 自动执行完整生命周期;快速 worker 使"接受期取消"在服务层不可确定性复现,成功取消路径由 core 确定性覆盖、服务层断言诚实的终态拒绝;④ 操作面枚举四处同步(coordinator 18→19、MCP 14→15、迁移计数 8→9、bin 注释去业务角色名);⑤ E2E 截图钩子作用域(同 G4/G5 教训)、G1 清单加 `inbox`、第二会话确认需显式选 reviewer 角色并补齐授权能力(requested≠granted≠authorized 三层语义的又一实证)。

## 5. 验证项对照(06G6 工作项 5 / 计划 §14 验证段)

- **重叠请求逐项对应**:listInbox 分页/过滤(service 测试);GUI 列表轮询渲染。
- **独立结果/权限作用域**:owner artifacts.read 不做参与者校验但读不产生写权;会话面保持原 `requireParticipant`。
- **零主聊天注入/迟到拒收**:既有核心语义(G3/G4 已验收);inbox.list 只读条目,不注入。
- **取消/到期后产物不采纳**:cancel 后 cleanup_pending=1;终态拒绝再取消(service+core 双层实证)。
- **新主实例对旧代次结果的冲突如实显示**:接收时固定 binding 不迁移(既有),详情显示固定代次/知识版本。
- **完成和清理失败可区分**:迁移 9 `cleanup_error_json`;core Held 夹具实证失败记录+终态不变+GUI 分列显示。
- **用量未知不显示 0**:接受/排队期 usage=null(GUI 显示"未知"),执行后报告实际值(service 测试两态断言)。
- **十个真实重叠请求**:规模性由分页边界与过滤覆盖;E2E 为单请求全链(自动化可行范围内)。

## 6. 证据

`docs/phase-reports/evidence/2026-10-28-p6-g6/automated/`:`gui-01-inbox-page.png`(收件箱页:completed 请求、产物查看、采纳指引、回收视图)、`shell-e2e-g6.log`(15/15)。真机补充证据(含 G4/G5 遗留)按既有 STEPS 随 G7 收口。

## 7. 退出条件自查(06G6)

- GUI 从接收→执行→真实答案全链可见,无需 admin CLI(E2E 实证);completed、收件已读、adopted 三维度分列(详情区分状态/收件条目/采纳指引)。
- 已知缺失用量显示未知(两态断言);不做 DAG/嵌套自动请求/主聊天注入(未做)。

## 8. 遗留与风险

1. 真机补充证据(G4 gui-03…07 + G5 知识页 + G6 收件箱)按 STEPS 随 G7 收口。
2. "接受期被 owner 取消"在服务层因 25ms worker 不可确定性复现——成功取消+幂等重放由 core 确定性覆盖,服务层覆盖终态拒绝(已在测试注释说明)。
3. GUI 分页控件未做(单页 limit 200/100,条目为请求量级);比较/产物渲染为纯文本。

## 9. 停止点

本阶段完成即停止:不进入 G7、不推送远程。按批次提交本阶段变更,交独立验收 Agent 按 `prompts/REVIEW.md` 形成 `P6-G6-review.md`。
