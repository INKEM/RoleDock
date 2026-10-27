# P6-G6 独立验收报告：请求、产物与收件箱

日期：2026-10-28。结论：**REWORK**（一项返工项 R1，中优先级——契约 §2.3 为两个 G6 读操作定档的输入面（`requests.listInbox` 时间过滤、`inbox.list` 分页）未实现且未按契约自身规则修订契约；其余验收条件全部满足。R1 为对齐性返工，修复后按 §6 复验，不必重验本报告已 PASS 的行为范围）。

依据：AGENTS.md（硬性约束）、prompts/REVIEW.md、prompts/COMMON.md、prompts/06G6-requests-and-inbox.md、[P6-G6-development.md](P6-G6-development.md)（开发声明仅作线索，不作结论）、[P6-G6-plan.md](P6-G6-plan.md)（范围裁定留档）、[desktop-gui-contract.md v9 §2.2/§2.3/§3/§4/§5/§6](../spec/desktop-gui-contract.md)、[DESKTOP_GUI_PLAN.md §14](../DESKTOP_GUI_PLAN.md)、[sdk-operations.md](../spec/sdk-operations.md)、前序 [P6-G5-review.md](P6-G5-review.md)（R1 已随 5ac45ee 修复）与 [P6-G5-rework.md](P6-G5-rework.md)。本轮止于验收：未修改产品实现、契约或开发报告，未做任何 commit/合并/发布。

## 1. 验收基线

- HEAD：`4289c18`（main；`5ac45ee`（G5-R1 修复收口）之上叠加 G6 四个提交：`6ab340f` core/service/mcp/protocol、`4d03bfc` desktop、`ee1cc9b` 契约 v9+报告+证据、`4289c18` 流水线日志）。
- 工作区：验收开始与结束时**均干净**（`git status --porcelain` 零行）；本轮全部运行（含 shell E2E）使用临时目录，未翻动 `evidence/…/user-data`，无需还原。
- 本阶段 diff（`5ac45ee..HEAD`）：41 个文件、+1709 行，与开发报告 §2 声明的源码范围一致（protocol 5 Schema+类型+control-operation 5 分支；core admin/requests/migrations/anchor/coordinator；service/mcp；desktop contract/ipc/controller/renderer）。

## 2. 独立运行的验证命令与退出码

| 命令 | 独立结果 | 退出码 |
| --- | --- | --- |
| `nvm use` + `node --version` | v22.23.2（engine-strict 生效） | 0 |
| `npm run check`（typecheck 全量 + build + vitest 全套） | **553/553 PASS（59 文件，562s）**，含 G6 core 4 项、G6 service 2 项、shell/probe 词汇表 G6 用例、no-business-roles 73 文件扫描、coordinator 操作面 19 项、MCP 15 工具、迁移计数 9 | **0** |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts`（仓库根） | **15/15 PASS（1.2m）**：G1×6 + G2×5 + G3×1 + G4×1 + G5×1 + **G6×1 全链**（真实 Electron + 真实 service + 真实 MCP stdio，零模型轮），无跳过 | **0** |
| 验收方探针 `/tmp/g6-review/service-probe.mjs`（真实 WorkspaceService RPC 面，A/B 两组 **30 项断言**） | 30/30 PASS | 0 |
| 验收方探针 `/tmp/g6-review/core-probe.mjs`（core 直驱，**12 项断言**） | 12/12 PASS | 0 |
| 验收方探针 `/tmp/g6-review/overlap-probe.mjs`（十实际重叠请求，**10 项断言**） | 10/10 PASS | 0 |

抽查证据 `docs/phase-reports/evidence/2026-10-28-p6-g6/automated/`：`shell-e2e-g6.log`（15/15 采集运行，与验收方独立运行一致）；`gui-01-inbox-page.png` 与代码渲染路径逐项相符（列表：completed 请求、固定绑定"代次 1·知识 r0"、用量"输出字节 5·预留轮次 1"；详情：问题全文、结果哈希、**采纳指引** `documents.publish(adopt_artifact_id=art-…)`、产物正文+哈希标注、**终态诚实拒绝**"不可再取消/重试执行；如需继续，请发起新的请求（新意图）"；回收视图"回收完成"）。开发报告 §4 的失败/返工记录（schema 非法 JSON、core setup 缺口、service 双锚定改法、操作面四处枚举同步、E2E 钩子）如实披露，未发现隐瞒。

## 3. 逐条验收条件核对（06G6 五项工作 → 实际代码/行为/测试）

| 提示词工作项 | 核对结果 | 关键位置/证据 |
| --- | --- | --- |
| 1. owner 请求/产物/预算/回收详情和分页；发起/目标、固定代次快照、真实正文哈希、inbox 与候选状态 | **PASS（R1 涉及其输入面，见 §5）**。四个纯投影 `requests.listInbox`/`requests.get`/`artifacts.read`/`requests.listCleanup` 实现于 WorkspaceAdmin，全部纯 SELECT（验收方 digest 探针：全部表前后逐字节不变，含翻页与过滤路径）；条目含 initiating/target、`binding{target_generation,knowledge_revision}`、budget、`execution_uncertain`/`cleanup_pending`、usage（未知=null）、result{artifact_id,content_hash}；详情 question 含 `[initiator input]` 追加历史（澄清回复正文可达）；产物正文经内容寻址读取并复核 `bodyHash(body)===content_hash`；回收视图 cleanup_pending/cleanup_error 分列。传输边界 Schema 校验（`owner-requests`/`owner-request-detail`/`owner-artifact`/`owner-cleanup`），边界输入（limit 0/201/-5/1.5、非法 cursor、非法 state、UPPER 角色）全部 `VALIDATION_FAILED`（探针 A8） | `packages/core/src/admin.ts:454-567`、`packages/service/src/index.ts:219-251`、`packages/protocol/schemas/owner-*.schema.json`、core 探针 Q5/Q6、service 探针 A8 |
| 2. 固定会话身份的收件箱/候选读取工具；普通会话没有 owner 操作 | **PASS**。SDK 新操作 `inbox.list`（coordinator 19 操作之一，`listSessionInbox`）固定为调用会话自身绑定角色（`sessionCall` 以 `binding.session_id` 注入，SQL 按 `owner_role_id` 过滤）；unread/read 维度 + `unread_only`；只读。MCP `inbox_list`（15 工具）E2E 实证可用。隔离实证：非目标角色 `inbox.list` 为空（探针 A5d/Q7c）、session 主体调 `requests.listInbox/cancelByOwner/listCleanup` 全 `PERMISSION_DENIED`（探针 A5a）、trusted 主体五操作全拒（service 测试）；`sdk-operations.md` 已同步（18→19）；owner 面无 `documents.publish`（探针 A7a） | `packages/core/src/requests/service.ts:487-528`、`anchor.ts:652-653`、`coordinator.ts:247-258,503`、`packages/mcp/src/index.ts:28`、core 探针 Q7、service 探针 A5 |
| 3. GUI 管理取消=独立 owner 操作与审计，不借发起 session 身份；补充回复由原发起会话执行 | **PASS**。`requests.cancelByOwner`：无任何 session_id 入参（对比会话版 `cancelRequest` 走 `resolveSessionIdentity`+`requireSessionCapability`）；独立审计 outbox 事件 `owner.request.cancel`（payload 仅 request_id/reason/actor=owner，无会话身份——探针 Q4）；`adapterCancelDeclared` 由 service 透传自身适配器能力（`index.ts:235`），owner 不能绕过；§6 矩阵逐格成立（见 §4.1）；补充回复仍走 `requests.reply`（原发起会话，取消后迟到回复 `INVALID_STATE_TRANSITION` 不复活——探针 A2b）；GUI 无 reply/publish/adopt 通道（词汇表测试锁定 `inbox` 命名空间恰 5 方法且显式断言无 reply/publish/adopt） | `packages/core/src/requests/service.ts:530-599`、`shell-contract.test.ts:42-48`、`inbox.ts:104-116`、core 测试 1、service 探针 B1、core 探针 Q2/Q4 |
| 4. 结果只建议采纳/转到原会话；由当前主角色 `documents.publish(adopt_artifact_id)` 正式采用；超时/撤销/代次冲突如实呈现 | **PASS**。GUI 只显示指引文本与产物引用，无代写正文通道；采纳守卫为既有 P4 语义且未被削弱：`publish(adopt_artifact_id)` 校验请求 completed、`binding_generation===当前 head.generation`（旧代次 `REVISION_CONFLICT`——"新主实例对旧代次结果的冲突如实显示"）、契约版本一致、收件条目随采纳置 read（`documents/service.ts:429-480`）；取消/到期产物无 artifact 无哈希（探针 Q8），不进入采纳链（§6.2"通知不是答案"）；撤销/超时经执行器每轮重读终态+期限+授权（`executor.ts:26-42`），如实转 failed/expired | `documents/service.ts:425-480`、`inbox.ts:84-87`、`executor.ts:128-233`、core 探针 Q8、E2E 步骤 5 |
| 5. 验证十实际重叠请求、独立结果/权限、零主聊天注入、迟到拒收、预算支出前校验和回收状态；用量未知不显示 0 | **PASS**。十实际重叠请求由验收方探针补验（T1–T10：10 个并发创建+2 个中途取消，list 与逐项 detail 的 state/binding/usage/result 一一对应，limit=3 游标遍历覆盖同集，state/target_role 过滤正确）；独立结果=内容寻址产物+按角色收件；零主聊天注入=结果只入 `request_inbox` 由会话拉取（`inbox.list`），无任何向主会话的推送通道；迟到拒收=取消后回复 `INVALID_STATE_TRANSITION`+执行器 TERMINAL 全检（探针 A2b、A1h、C3）；预算支出前校验=轮次预算在执行前（`executor.ts:155-157`）、输出预算在提交前（`:181-183`），P4 既有；回收状态=迁移 9 失败可区分/终态不变/成功清空/持久重试（g6 测试 3 + 既有 rework 测试"重试终态清理"：首次 close 失败→重试成功→不重执行）；用量未知=null（探针 B1a 确定性实证 accepted 态 `{output_bytes:null,turns_reserved:null}`，A6a 执行后报告实际值），GUI 渲染"未知" | 探针 overlap/core/service、`executor.ts`、`migrations.ts:389-391`、`inbox.ts:17-18` |

**退出条件**（06G6）："用户从 GUI 看完整请求到真实答案、当前角色显式采纳后的确切修订，无需 admin CLI；completed、已读和 adopted 分开。不加任务 DAG 或嵌套自动请求"——**达成**。E2E 全链（双会话锚定→`requests.create`→worker 自动执行→GUI 列表/详情/产物→终态诚实拒绝→回收视图→MCP `inbox_list`）；三维度分走三条数据路径：completed=请求状态（G6 页）、已读=采纳时 `request_inbox` 置 read（会话面 `inbox.list` 可见）、adopted=候选+确切修订（G5 知识页）；GUI 页头明示三者分列。未做任务 DAG/嵌套自动请求/后台注入（词汇表与代码均无）。

## 4. 重点独立核查结果（验收方亲测，非仅测试绿）

1. **§6 cancelByOwner 矩阵逐格**（RPC 面 + core 直驱双层）：
   - `accepted`→cancelled（探针 B1c，经真实 owner RPC；cleanup_pending=1+terminal_at 写入——Q3）；同键重放返回首次结果+`idempotent_replay:true`（B1d）；同键不同输入 `IDEMPOTENCY_CONFLICT`（B1e）；不同键对终态 `REQUEST_NOT_TERMINABLE`（B1f）。
   - `queued`→cancelled（core 探针 Q1–Q3：经纯 `replyToRequest` 服务函数在 queued 态确定性取消）。注：协调器包装在 reply RPC 返回前**内联执行**再排队请求（`coordinator.ts:397-403`），故 queued 态对 RPC 观察者仅在"崩溃于回复提交与内联执行之间"或"内联执行前置校验失败回滚"时持久——语义与 accepted 同一 `CANCELLABLE_STATES` 集与同一 UPDATE，无独立分支差异。
   - `awaiting_input`→cancelled（探针 A2a）；随后 `requests.reply` 迟到拒收 `INVALID_STATE_TRANSITION`（A2b）。
   - `running` 无适配器 cancel 能力→`REQUEST_NOT_TERMINABLE` 且状态不变（core 测试 1 Held 夹具：抛错后行状态仍 running）；有能力→cancelled（core 测试 1）。
   - 终态四态（completed/failed/cancelled/expired）不同键拒绝（B1f、service 测试 87-88 行）。
   - 独立审计：`owner.request.cancel` 事件在 `admin.events` 元数据视图可见（B1g），payload 无会话身份（Q4）；**不借发起 session 身份**——代码路径无 session_id 入参、RPC 面会话主体调用被拒（A5a）。
2. **迁移 9 `cleanup_error_json`**：回收失败记录且**终态不变**（g6 测试 3：cancelled 保持 cancelled）；成功清空（executor 同步写/清两处 + 探针 A7b）；持久重试（tick 循环每轮取 `cleanup_pending=1`，既有 rework 测试实证"首次失败→重试成功→不重执行副作用"）。
3. **owner 五视图纯只读**：digest 探针对库中全部表做前后逐字节对比，四次投影+翻页+过滤零写入（Q5）。owner 投影不执行惰性到期（到期是写操作，由会话面读与 worker 承担，owner 视图如实显示存储态）——该取舍与"投影只读"一致。
4. **用量投影**：`#requestUsage` 仅在 accepted/queued 且 `execution_phase='pending'` 时返回 null；awaiting_input/running/completed 报告实际值（A1a 迹象与 A6a 均为实际值）；Schema 两字段可空并注明"null=未报告，绝不渲染为 0"；GUI 渲染"未知"（`inbox.ts:17-18`）。
5. **artifacts.read（owner 版）**：不做参与者校验（§3.2 owner 全文定档）但**读不产生写权**——owner 面无 documents.publish（A7a）；正文 sha256===content_hash 逐字节对应（A6b），经 shell IPC 的 `body` 键走 G5-R1 的 `BYTE_FAITHFUL_FIELD` 逐字节保真（双桥一致，redact.ts/bridge.ts:30）。
6. **会话面参与者校验未被削弱**：session `requests.get` 参与者可用（A5b）、非参与者 `PERMISSION_DENIED`（A5c）、session `artifacts.read` 非参与者拒绝（A6f）；owner 版与 session 版同名操作是**不同 dispatch 路径**（service `invoke` 对 session 主体直接转 `connection.call`，不进入 owner 分支，`index.ts:99`）。
7. **操作面枚举一致**：coordinator 19（`coordinator.test.ts:52`）、MCP 15（`mcp.test.ts:34`）、shell 词汇表（G1 清单加 `inbox`，5 方法封闭）、迁移计数 9（`store.test.ts`）、no-business-roles 73 文件扫描（含 cli/bin）、`sdk-operations.md` §6 `inbox.list` 已补。
8. **GUI 有界轮询**：2s 间隔，`document.hidden` 暂停、hashchange 移除监听（`inbox.ts:139-145`）；列表/回收视图轮询，详情点击刷新；错误经 error boundary 诚实显示（REQUEST_NOT_TERMINABLE 原文可达，不得显示已取消——GUI 对 running 仅提示规则，失败显示服务端错误原文）。

## 5. 返工项

### R1（中）：契约 §2.3 为两个 G6 读操作定档的输入面未实现，且未按契约自身规则修订契约

- **触发条件**：对照 desktop-gui-contract v9 与实现：
  1. §2.3 `requests.listInbox`（owner 版）行输入要点"分页，按 state（协议枚举）/role/**时间过滤**"——实现仅有 `state`/`target_role_id` 两个过滤（`admin.ts:487-498`、Schema `owner-requests` 输入分支），无任何时间过滤参数；DESKTOP_GUI_PLAN §14 工作段同样明文"补 owner 有界读视图和按角色/状态/**时间**筛选"。
  2. §2.3 `inbox.list`（session 面）行输入要点"**分页**"、§2.1 通用约定对"所有 list/读操作"定档 `{cursor?,limit?}` 分页——实现为全量 `{entries}`（`requests/service.ts:507-528`），无 cursor/limit；本阶段同步的 `sdk-operations.md` §6 也只写 `unread_only`，与契约 §2.3 相互矛盾。
  同时 §2.2 页面映射与 v9 头注将两操作标为"**G6 已实现**"，开发报告 §1 声明按契约交付。契约 §2.2 自身规则："首版页面行为无裁剪……若后续子阶段要缩减，**须先修订本契约与桌面计划并说明**"——缩减仅写入了计划（`P6-G6-plan.md` §0 按计划裁为 state/role 过滤），**契约未修订**，形成"标注已实现、定档输入面与实际不符"的缺口。
- **位置**：`packages/core/src/admin.ts:487-498`（listInbox 过滤）、`packages/core/src/requests/service.ts:507-528`（inbox.list 无分页）、`packages/protocol/schemas/service-control-operation.schema.json`（listInbox 输入分支无时间字段）、`packages/mcp/src/index.ts:28`、`docs/spec/desktop-gui-contract.md` §2.3 两行、`docs/DESKTOP_GUI_PLAN.md` §14、`docs/spec/sdk-operations.md` §6。
- **影响**：契约是该仓库接口的定档权威（"先固化契约，不假称已有"）；G7 的 GUI-08 将以请求 1000 的造数集验收列表与筛选，届时时间过滤缺失会直接撞上契约声明；两个权威文档（契约 vs sdk-operations.md）对 inbox.list 输入面相互矛盾，后续实现无所适从。不涉及权限、状态机或正确性，故为中优先级。
- **修复要求**（二选一，逐项落地）：
  - **实现路径**：`requests.listInbox` 增加时间过滤（建议 `created_after`/`created_before` 或 `updated_since`，ISO 8601，进 Schema 输入分支与 admin 过滤，配边界测试）；`inbox.list` 按 §2.1 补 `{cursor?,limit?}` 分页（或与 §2.3/§2.1 一致的批量约定），同步 MCP 工具入参与 sdk-operations.md。
  - **修订路径**：保留现实现，修订契约 v9→v10：§2.3 两行的输入要点改为实际交付面并注明"时间过滤/分页延后至 G7（GUI-08 造数集需要时实施）"及理由，v9 头注补记；同时更新 `P6-G6-plan.md` 之外无需动 sdk-operations.md（其已与实现一致）。修订须在报告与流水线日志留痕。
- **复验方法**：实现路径——重跑 `npm run check`（新过滤/分页测试 + 枚举/Schema 一致性）与 shell E2E 15 项；修订路径——核对契约两行与实现/Schema/MCP/sdk-operations 五处逐一一致，无剩余"已实现但输入面缺失"的行。

## 6. 开发报告 §8 声明的限制核查

1. **"接受期被 owner 取消在服务层因 25ms worker 不可确定性复现"（§8.2）——声明过强，不成立为一般命题**：worker 轮询间隔是启动参数（`pollMs`，最小 10ms、无上限），验收方以 `pollMs=800` 在真实 RPC 面**确定性复现**了接受期取消及幂等三连（探针 B1c–B1h），并用 Held 适配器钉住 worker 使 accepted/queued 窗口稳定可观察。该声明对其 25ms 测试环境属实，但由此留下的服务层覆盖缺口是**可补的**：建议随 R1 复验把确定性服务层用例（慢 pollMs 或 Held 适配器）补进 `packages/service/test/g6-requests-inbox.test.ts`（并入 R1，不单列）。核心层覆盖（g6 测试 1）本身是确定且真实的。
2. **真机补充证据随 G7 收口（§8.1）**：与 G4/G5 既有裁定一致（O-A，见 §7）。
3. **GUI 分页控件未做、渲染为纯文本（§8.3）**：与 G4/G5 O-C 同性质，core/service 分页契约已实现并经探针 T7 验证；观察项不阻塞。

## 7. 观察项（不影响本阶段结论）

- **O-A（承接）**：G4 gui-03…07+Findings、G5 知识页、G6 收件箱真机截图仍待采（目录与 G5 验收时一致）——按既定裁定随 G7 产品证据收口（GUI-04…07 矩阵）最迟补齐。
- **O-B（低）**：GUI 管理取消的成功路径（accepted/awaiting_input→cancelled 经 `#/inbox` 页输入原因→IPC→RPC）无端到端 exercise——E2E 因 worker 自动执行只能覆盖诚实终态拒绝；`inbox:cancelRequest` handler 仅有词汇表锁定、无行为测试。底层操作已由 core/service/探针三重验证，handler 为薄代理；建议在补 O-A 真机材料时以真实 GUI 点击取消一次留证（或加一条 Held-adapter E2E）。
- **O-C（低）**：owner 取消 running 请求时**未调用适配器的协商取消**（`adapter.cancel`）：会话路径经 `coordinator.cancelRequest`→`cancelRunningRequest` 显式中断宿主轮次；owner 路径置终态后依赖维护循环 `cleanupRequest`→`adapter.closeSession` 回收分支，宿主侧产出按迟到拒收。状态语义与 §6 一致（终态+迟收），但"声明了 cancel 能力"的适配器其轮次级中断 API 在 owner 路径未被行使——对 zcode 真实适配器的实际停止行为建议在 G7（GUI-09）以真机证据确认。
- **O-D（低）**：`idempotency_keys` 主键为 `(workspace_id, idem_key)`，未含 §5 的 operation 维度；当前仅 cancelByOwner 写该表（全仓唯一写入点已核实），无碰撞可能；未来第二个写操作共享此表时需先落 (operation, key) 命名空间纪律。
- **O-E（记录）**：GUI 未渲染收件条目 unread/read 维度（由会话面 `inbox_list` 与 owner `admin.inbox` 承载，契约 §2.2 如此映射）；G7 GUI-08/GUI-10 造数集验收时可一并评估是否上页面。
- **O-F（记录）**：`owner-requests` Schema 的 `result.summary` 为可选字段但实现从不输出（收件条目 summary 仅存于 `request_inbox`）；无害超集，随 R1 修订时可一并清理或补齐。

## 8. 测试真实性总评

各层测试均有行为断言而非逐字复述实现：core 断言审计事件落库、cleanup_error 写入与终态不变、Held 夹具下 running 状态不变、inbox 仅本角色；service 断言真实 worker 生命周期、trusted 主体五操作全拒、传输边界拒绝；E2E 用真实 Electron+service+MCP stdio 完成双会话锚定→请求→产物→诚实拒绝→回收→inbox_list 全链，零模型轮如实标注。开发报告声明的数字（553/553、15/15、4/4、2/2）与验收方独立运行一致。验收方另补四类产品测试未覆盖的检查：RPC 面确定性 cancel 矩阵（含幂等三连与审计 payload）、只读投影的存储级 digest、十实际重叠请求的逐项对应、非参与者读写隔离。

## 9. 范围限制

- 未独立重跑真机步骤（需真实 ZCode 桌面会话与用户配合）——按 §7 O-A 裁定待采。
- 未重跑 `npm run desktop:e2e`（probe 回归）；shell IPC 边界随 15 项 shell E2E 覆盖。
- 未复跑开发侧证据采集运行（`automated/shell-e2e-g6.log` 为开发侧采集）；以验收方自身 15/15 运行与截图内容核对替代。
- 验收方临时材料位于 `/tmp/g6-review/`（`service-probe.mjs`、`core-probe.mjs`、`overlap-probe.mjs`；`node <file>` 直接运行，均自建临时工作空间并清理），不入库、不影响工作区（验收结束工作区干净）。

**P6-G6 结论：REWORK**——完成 R1（契约 §2.3 输入面：listInbox 时间过滤与 inbox.list 分页，实现或修订二选一；随附建议补服务层确定性接受期取消用例）并按 §5 复验后，本阶段即成立，可进入 G7；R1 不要求重验本报告已 PASS 的 cancel 矩阵、投影只读、隔离与采纳链语义。本轮不自动开始修复、不提交、不发布；本报告不授予合并或发布权限。
