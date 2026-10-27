# RoleDock 桌面 GUI 操作契约（P6-G0 定档）

日期：2026-10-25；**v2 返工修订 2026-10-26**（按 `P6-G0-review.md` R01–R03：脱敏分层定档、管理取消对齐真实状态机、页面动作→操作映射补全）；**v3 复验返工修订 2026-10-26**（按 `P6-G0-rework-review.md`：R01 结构化公开哈希/标识逐字节保真、自由文本仅具名字段掩盖；R03 checkpoint 摘要/待办对齐协议 Checkpoint 类型；G1 交付 `workspace.info` 扩展见 §2.3）；**v4 G2 实现标注 2026-10-26**（`roles.get`/`policy.list`/`workspace.runtimeStatus` 已实现并注册 Schema；`workspace.preflight`/`testConnection` 桌面预检切分；shell 清单见 §4）；**v5 G2 返工修订 2026-10-26**（目录↔workspace_id 身份文件绑定校验、每工作空间 launcher 持久化恢复、连接器按 dev/packaged 真实文件路径解析并以 `node --check` 预检、launcher 配置防链接写入、角色详情返回安装快照正文）；**v6 G2 复验返工修订 2026-10-26**（workspace-id 跨停机持久，活端点附着必须证明身份——缺失/损坏即 conflict；持久化 launcher 配置分 absent/present/error，损坏显式失败不退 mock；角色材料按包契约一律按路径从安装快照解析，缺失/损坏显式失败，不用扩展名猜内联文本）；**v7 G4 实现标注 2026-10-28**（`authorizations.revokePreview`、`sessions.listBindings/listAttempts/listLoads` 已实现并注册 Schema（`session-bindings`/`anchor-attempts`/`anchor-loads`/`revoke-preview`）；绑定视图新增 `effective_state`（显示层有效性，投影只读不写库）与 `state_changed_at`（迁移 8，旧记录如实为 NULL 不回填）；shell 清单新增 `sessions:`/`authorizations:` 命名空间并补记 G3 `bridgeStatus`，见 §4）。
状态：**G0 契约定档（开发方候选）；标注"已实现"的行已交付**。本文定义接口名、输入/输出要点、可见性与幂等规则；每个操作在其目标子阶段实现时**先补 protocol Schema 与 TS 类型，再接 UI**（DESKTOP_GUI_PLAN §5.1）。未实现行的名字不占用稳定协议名。基线 HEAD `d9743365` + 未提交工作区。

关联：[桌面 GUI 分阶段计划](../DESKTOP_GUI_PLAN.md)、[ADR-0013](../adr/0013-desktop-orchestration-and-owner-views.md)、[toolchain](../toolchain.md)。

## 1. 基线能力盘点（对照当前代码）

**owner 面（service 控制面，`packages/service/src/index.ts:90-127`）已有：**
`workspace.info`（G0 基线时仅 `workspace_id`；**G1 已扩展为 `workspace_id + service{version,pid,started_at,adapter,runtime}`，协议 `WorkspaceServiceInfo`，Schema `workspace-service-info` 已注册并在 service 传输边界校验**）、`connections.trust`、`authorizations.recordOwner|submitHumanEvent|revoke`、`externalSessions.list`（G-min 读视图）、`roles.install|list|resolve`、`knowledge.export|import`、`policy.show|grant|revoke`、`admin.inbox`、`admin.events`。

**session 面（MCP 14 工具，`packages/mcp/src/index.ts:12-28`）已有：**
`authorizations.get`、`sessions.anchor|binding|reconcile|release`、`documents.list|read|propose|publish`、`requests.create|get|reply|cancel`、`artifacts.read`。

**关键形态限制（G0 核实，后续阶段不得假设更强语义）：**

- `admin.events` 是对 outbox 表的一次性 SQL SELECT（id/kind/state/created_at，`packages/core/src/admin.ts:121-148`）——**不是订阅**：无推送、无游标、无长轮询。首版所有视图一律有界轮询 + `observed_at` 快照（ADR-0013 决策 7）。
- `admin.inbox` 返回收件条目（entry/state/时间），**不含请求 payload，不是请求详情**。
- owner 面目前**没有** documents、requests、artifacts 的读接口（G5/G6 增量）；bindings、anchor attempts、loads 与撤销影响预览已由 **G4 补齐**（`sessions.listBindings/listAttempts/listLoads`、`authorizations.revokePreview`，Schema 已注册并在传输边界校验）；`sessions.binding`/`requests.get`/`artifacts.read` 仅限 session principal。
- 请求状态机以协议为准（`collaboration-request.schema.json:65-77`）：`accepted, queued, running, awaiting_input, completed, failed, cancelled, expired`；`execution_uncertain` 是 accepted/queued/running 上的布尔子状态；终态不可逆。**协议中没有 `awaiting` 这一状态。**
- 现有会话取消守卫（`packages/core/src/requests/service.ts:436-484`）：可取消集 `{accepted, queued, awaiting_input}`；`running` 仅当适配器声明 cancel 能力，否则 `REQUEST_NOT_TERMINABLE`；取消/到期置 `cleanup_pending=1`；终态请求不可再取消、不能再次产出结果。
- service bin 仅 `--mock-workspace` 一种启动形态；真实适配器接入属 G2/G3。

## 2. owner 读模型与控制操作契约

### 2.1 通用约定（所有 list/读操作）

- **主体**：除标注"session 面"外，均为 service 控制面 owner principal 专用；owner 读模型**不借用 session 身份**，也不接受渲染层传入 session_id 冒充角色。
- **分页**：请求 `{ cursor?: string; limit?: number }`，`limit` 默认 50、上限 200，可按资源加过滤字段；响应 `{ workspace_id, observed_at, items, next_cursor }`；cursor 不透明（编码 `created_at|id`），服务端不保存游标状态，翻页间变更以后到页面为准。
- **错误**：复用现有 `ErrorEnvelope`；未知操作与越权 `PERMISSION_DENIED`；状态不允许 `INVALID_STATE_TRANSITION` / `REQUEST_NOT_TERMINABLE`（沿用现有错误码，不新增别名）。
- **实现纪律**：下表操作全部**未实施**；实现子阶段先补 Schema/类型与该操作的输出 DTO 字段白名单（§3 第 1 层），再接 UI。

### 2.2 页面动作 → 操作映射（对照计划 §6 五页面；"现有"= 已实现可直接复用）

| 页面（计划 §6） | 页面动作 | 操作（现有 / 契约名→阶段） |
| --- | --- | --- |
| 工作空间与连接（G1/G2） | 最近目录、新建/打开、服务启停 | 桌面本地编排（非 RPC；目录选择/服务监督见 §7），G1 |
| | 预检、版本、连接器/helper 配置、受管状态、诊断 | `workspace.info` 扩展（G1）；`workspace.runtimeStatus`（G2，受管验证状态）；`admin.events`（现有，诊断；只读元数据） |
| 角色库（G2） | 包安装 | `roles.install`（现有，owner） |
| | 职责/模板/输出 Schema、版本哈希、需求 vs 实际策略、当前主代次 | `roles.get`（G2）；`policy.list`（G2）；`roles.list`（现有） |
| 授权与会话（G3/G4） | 宿主会话发现、原会话登记 | `externalSessions.discover`（G3，trusted 读）；`externalSessions.register`（现有，trusted 写）；见 §9 |
| | 授权范围/来源/到期、确认进度 | `authorizations.confirmations`（**G3 已实现**）；`externalSessions.list`（现有） |
| | 锚定/载入/代次、继承关系 | `sessions.listBindings`/`listAttempts`/`listLoads`（**G4 已实现**） |
| | 撤销与影响预览 | `authorizations.revoke`（现有）；`authorizations.revokePreview`（**G4 已实现**） |
| 角色知识（G5） | 文档目录、当前正文 | `documents.list`（G5，owner 投影）；`documents.read`（G5，owner 版，正文按 §3） |
| | 历史、修订比较 | `documents.listRevisions`（G5）；比较规则见该行与 §3 |
| | checkpoint 摘要/待办 | `checkpoints.list`（G5，摘要 + todos 概览）；`checkpoints.get`（G5，详情：handoff_summary.body + todos 全量 + sources）；另：绑定引用缺失/过期属**状态诊断**（`sessions.listBindings` 对照），与业务待办分列，不互相冒充 |
| | 候选（来源/基线/正文） | `documents.listCandidates`（G5）；`proposals.submit`（G5/G6，owner 提议） |
| | 导入导出 | `knowledge.export`/`knowledge.import`（现有） |
| 请求收件箱（G6） | 请求列表/详情（代次、快照、问题、期限、用量、澄清状态） | `requests.listInbox`（G6，owner 版）；`requests.get`（G6，owner 版） |
| | 真实产物正文/哈希 | `artifacts.read`（G6，owner 版） |
| | 管理取消 | `requests.cancelByOwner`（G6，矩阵见 §6） |
| | 回收状态、清理失败可区分 | `requests.listCleanup`（G6） |
| | 角色收件箱 unread/read | `inbox.list`（G6，session 面新工具）；`admin.inbox`（现有，owner 条目级） |

首版页面行为**无裁剪**：上表未出现"留待将来"的页面动作；若后续子阶段要缩减，须先修订本契约与桌面计划并说明。

### 2.3 操作契约表

| 契约名 | 阶段 | 类型 | 输入要点 | 最小输出要点 |
| --- | --- | --- | --- | --- |
| `workspace.info`（扩展，**G1 已实现**） | G1 | 读 | — | 现有 `workspace_id` + `service{version,pid,started_at,adapter,runtime}`（协议 `WorkspaceServiceInfo`）；只暴露非敏感运行信息，不含 argv/路径/凭据 |
| `workspace.runtimeStatus`（**G2 已实现**） | G2 | 读 | — | **service 端受管声明与依据**：adapter、level（full/restricted）、isolation 四项（协议 `WorkspaceRuntimeStatus`，Schema `workspace-runtime-status` 已注册并在传输边界校验）。runner 可用性/出口白名单/连接测试属**桌面预检**（`workspace.preflight`/`testConnection`，只读不消费模型）。「已连接」≠「隔离已验证」，两者分列 |
| `roles.get`（**G2 已实现**） | G2 | 读 | `{ role_id }` | 职责正文、文档模板**正文**、输出 Schema **内容**（均从安装快照按 content_hash 对应的 pack 副本解析，128KiB 上限、拒绝越界路径）、包来源与哈希、requested vs granted 对照、当前主代次与 `current_instance_id`；响应在 service 边界按 `role-details` Schema 校验 |
| `policy.list`（**G2 已实现**） | G2 | 读 | 分页 `{cursor?,limit?}`（默认 50，上限 200；cursor=页偏移 base64） | 策略授权表（`policy.show` 批量版，按 role_id 排序） |
| `authorizations.confirmations`（**G3 已实现**） | G3 | 读 | 分页 `{cursor?,limit?}`、按 `external_session_id` 过滤 | 确认进度链（owner 投影，Schema `authorization-confirmations` 在传输边界校验）：每会话的 human events（含各自产生的授权与撤销态）→ 最新 anchor attempt（state/error/load）→ binding（代次、状态）；观察时间 + 游标；投影只读，列表与查看不推进任何状态 |
| `authorizations.pendingEvents`（**G3 已实现**） | G3 | 读（trusted 面） | 输入必须为空；主体来自受信 principal | 本主体已登记会话中"事件已存储但尚无有效授权"的列表（Schema `pending-human-events`）；模型与普通会话不可调用，owner 面不可调用 |
| `externalSessions.discover`（**G3 已实现**） | G3 | 读（trusted 面） | 输入必须为空 | 宿主会话候选（Schema `host-session-discovery`）：host_session_id、标题、状态、kind、updated_at、`registered_external_session_id`（已登记标记）；只读枚举，不创建、不附着、不消费模型轮；发现不可用时 GUI 退回粘贴引用入口（计划 §11.6） |
| `authorizations.revokePreview`（**G4 已实现**） | G4 | 读 | `{ authorization_id }` | 撤销影响预览：将失效的绑定、委派中请求（含 `execution_uncertain`/`cleanup_pending`）；只读，撤销是独立的显式写（`authorizations.revoke`）；响应按 `revoke-preview` Schema 在传输边界校验 |
| `sessions.listBindings`（**G4 已实现**） | G4 | 读 | 分页 `{cursor?,limit?}`、按 `external_session_id` 过滤 | 绑定：role、代次、实例与前任、`state`+`effective_state`（显示层有效性：active 但 head 已易主显示 superseded，**投影不写库**）、来源授权（authorization_id/entry/actor/revoked_at/激活时知识版本）、有效能力、`checkpoint_id` 引用、`state_changed_at`（迁移 8 起记录；旧记录 NULL）；Schema `session-bindings` |
| `sessions.listAttempts`（**G4 已实现**） | G4 | 读 | 分页、按 `external_session_id` 过滤 | 锚定尝试：attempt 状态、确认四判据（host_session_id/load_key/content_hash/load_version）、失败原因（错误消息层）；Schema `anchor-attempts` |
| `sessions.listLoads`（**G4 已实现**） | G4 | 读 | 分页、按 `external_session_id` 过滤 | 载入记录：load_key、bundle_hash、材料版本 `load_version`、`prepared_at`/`confirmed_at`（迁移 8 起；未确认或旧记录为 NULL）；Schema `anchor-loads` |
| `documents.list` | G5 | 读 | 分页、按 role 过滤 | 目录：document_key、latest_revision、visibility、updated_at（不含正文） |
| `documents.read`（owner 版） | G5 | 读 | `{ role_id, document_key, revision? }` | 正文按 §3 矩阵 + `content_hash`（原始字节）；不可见正文 → 元数据 + 哈希，响应显式标注 `body_included: false` |
| `documents.listRevisions` | G5 | 读 | `{ role_id, document_key }` 分页 | 修订列表：revision、content_hash、visibility、来源、created_at；**比较规则**：owner 可见正文可全文比对；不可见正文仅元数据/哈希对照，不借任何接口取回正文 |
| `checkpoints.list` | G5 | 读 | 分页、按 role 过滤 | checkpoint 摘要：checkpoint_id、role、generation、knowledge_revision、material/document_snapshots 摘要、created_at、**`handoff_summary` 元数据（format/content_hash，不含正文）**、**`todos` 概览（total/done 计数与未完成项 description）** |
| `checkpoints.get` | G5 | 读 | `{ checkpoint_id }` | 详情：`handoff_summary.body` 全文（markdown，协议 Checkpoint 类型一致）与 content_hash、`todos[{description,done}]` 全量、`sources[]`、`user_decision_refs[]`、document_snapshots；正文可见性见 §3.2 |
| `documents.listCandidates` | G5 | 读 | 分页、按 role/来源过滤 | 候选：candidate_id、目标 role/document_key、**候选正文全文**（候选是明确提交待审的新内容，owner 可见）、原始基线 revision、当前基线 revision、来源（branch/owner/import）；基线正文本身按 §3 可见性（不可见基线只给哈希对照） |
| `proposals.submit` | G5/G6 | 写 | `{ target_role_id, document_key, body, note, baseline_revision, idempotency_key? }` | owner 候选提议；约束见 §6 末条与 §5 幂等 |
| `requests.listInbox`（owner 版） | G6 | 读 | 分页，按 state（协议枚举）/role/时间过滤 | 条目：request_id、initiating/target、state、`awaiting_input` 澄清状态、binding{generation,knowledge_revision}、budget、**已报告用量（缺失显示 unknown，不以 0 冒充）**、result 摘要（artifact_id/content_hash） |
| `requests.get`（owner 版） | G6 | 读 | `{ request_id }` | 完整详情：question/reply 正文、binding、budget、usage（可 unknown）、state、`execution_uncertain`、`cleanup_pending`、error{code,message}、result{artifact_id,content_hash}、initiating/target 标识 |
| `artifacts.read`（owner 版） | G6 | 读 | `{ artifact_id }` | body 原文字节 + `content_hash` + producing_role_id + request_id；读不产生任何写权/发布权 |
| `requests.cancelByOwner` | G6 | 写 | `{ request_id, reason, idempotency_key? }` | 管理取消；**逐状态矩阵见 §6** |
| `requests.listCleanup` | G6 | 读 | 分页，按 cleanup_pending 过滤 | 回收视图：request_id、state（终态）、`cleanup_pending`、cleanup_error（回收失败与完成**可区分**，不改终态） |
| `inbox.list`（session 面） | G6 | 读 | 分页 | 角色会话查询**自己的**收件箱：unread/read 维度、条目状态（现 14 工具无 inbox 查询） |

`admin.inbox`/`admin.events` 维持现状语义（条目级/元数据级），不升级伪装为详情或事件总线。

## 3. 可见性矩阵与脱敏分层（v2 修订）

### 3.1 脱敏的四层定义（R01）

1. **字段投影（权威层）**：每个操作的输出 DTO 按资源定义字段白名单，在实现子阶段随 Schema 一起定档。公开业务标识（`authorization_id`、`event_ref`、`document_key`、`artifact_id`、`content_hash`、`request_id` 等）**明确允许返回**——它们是关联/撤销/比较操作的必要主键；秘密凭据字段（token/secret/password/api key 类）不属于任何读模型 DTO，实现层直接不查询、不返回。
2. **字段名拒绝（传输层防御纵深）**：探针与后续 IPC 桥接统一 `redact()`（`packages/desktop/src/probe/shared/bridge.ts`）：按**字段名精确后缀**拒绝清单丢弃已知秘密字段（`token|secret|password|bearer|api_key|private_key|access_key`）。该清单**不含** `authorization_id`/`active_authorization` 等业务标识（v1 的子串误删已修正）。它兜底实现层漏配，不是投影的替代。
3. **自由文本显示投影（尽力而为，v3 修订）**：仅**具名自由文本字段**（message/body/detail/error/note/reason/description/summary/output/text/log 类键）的字符串值经 `scrubDisplayText()` 掩盖**标注型**秘密片段（`Bearer <值>`、`键: 值` 形态，值替换为 `[masked]`、标签保留）。**结构化公开值（content_hash、host_session_id、event_ref、workspace_id 等）一律原样返回、逐字节保真**——哈希比对与会话关联依赖精确值；无标注的秘密串不保证被掩盖（那是第 1 层投影的职责：结构化秘密根本不出现在 DTO）。两个桥接实现（probe 与 shell）行为一致并有相同断言。错误消息层与原始正文的层级照旧（attempts 只到错误消息层）。
4. **内容哈希**：`content_hash` 永远由源端对**原始字节**计算；经脱敏/截断的显示文本不得标注为与某 `content_hash` 对应的字节。结构化哈希字段本身逐字节返回（见第 3 层）。

### 3.2 资源 × principal 矩阵

图例：**全文**＝内容可读；**元数据**＝仅结构/时间/哈希等；**不可见**＝任何字段都不经该 principal 返回。

| 资源 | owner | trusted | session（绑定参与者） |
| --- | --- | --- | --- |
| 宿主原始私人聊天 | 不可见（仅宿主适配器内部可及） | 不可见 | 不可见 |
| 凭据 / owner-connection / token | 不可见（main 进程独占） | 不可见 | 仅自身 token（env 注入，不经接口回传） |
| 授权事件与授权记录（含 `authorization_id` 等公开标识） | 全文 | 不适用（仅 recordHuman 写者） | 仅本会话（`authorizations.get`） |
| 绑定、代次、释放状态 | 全文（含 host_session_id 标识；标识非聊天内容） | 不适用 | 仅本会话 |
| 锚定尝试 / 载入记录 | 全文（错误消息层） | 不适用 | 仅本会话（`sessions.reconcile`） |
| 文档 metadata（key/revision/作者/时间/哈希） | 全文 | 不适用 | 按角色可见性（现状） |
| 文档正文 public/工作空间级 | 全文 | 不适用 | 按角色可见性（现状） |
| 文档正文 private/role 级 | **仅元数据 + 内容哈希**（G0 决策：维持角色知识边界；owner 需要正文须先有显式工作空间策略，属 G6 议题） | 不适用 | 按角色可见性（现状） |
| 候选正文（branch/owner/import 提交的新内容） | 全文（候选是明确提交待审的内容）；**基线正文按上行的 private/role 规则**，不可见基线仅哈希对照，不构成正文外泄通道 | 不适用 | 提交分支可见自身候选 |
| checkpoint 交接摘要与待办（`handoff_summary.body`、`todos`、`sources`） | **全文**——交接摘要/待办是角色显式写入的交接产物，属知识页展示对象；其中引用的 private/role 文档正文本体仍按上文规则（摘要给出引用与哈希，不附带被隐藏正文） | 不适用 | 交接双方按现状 |
| 知识快照（export 结构） | 全文（export 本就是 owner 操作） | 不适用 | 不可见 |
| 请求 payload 正文（consultation 问题/回复） | **全文，凭据形态字段按 §3.1 投影+脱敏**（G0 决策，经用户确认） | 不适用 | 参与者可见（现状 `requests.get`） |
| 请求预算/状态（协议枚举）/`execution_uncertain`/`cleanup_pending` | 全文 | 不适用 | 参与者可见 |
| 产物 bytes | 全文 + 必带原始字节 `content_hash` | 不适用 | 按 `artifacts.read` 现状（读不产生写权） |
| outbox 事件 | 元数据（`admin.events` 现状，不伪装事件总线） | 不可见 | 不可见 |

## 4. 渲染层具名接口（`window.roledock.*`）

- preload 经 `contextBridge` 只暴露**具名方法**；清单封闭于代码常量（G0 探针样例：`PROBE_METHODS`）。每个页面的方法先入清单并补 TS 类型，再写 UI。
- **禁止**通用 `rpc(operation, input)` 通道；渲染层不得接收凭据字段（§3.1 第 1 层投影为权威，`redact()` 为传输层兜底）。
- main 进程是唯一凭据持有者：沿用 G-min 的 owner-connection 文件校验（属主 + 0600 + 常规文件）。
- **G1 生产入口（shell）**：`window.roledock.shell.{workspace, confirm, sessions, authorizations, roles, settings, app}`，方法封闭清单：workspace `pickDirectory/open/status/refresh/stop/restart/diagnostics/openWindow/preflight/testConnection/removeRecent`、confirm `listSessions/listRoles/submit/registerSession/discoverSessions/confirmations/bridgeStatus`（G3 增后四项，`bridgeStatus` 为 G3 受信桥状态诊断）、**sessions `listBindings/listAttempts/listLoads`（G4，分页 owner 只读视图）**、**authorizations `revokePreview/revoke`（G4 撤销面：先预览后撤销；无 release——释放仅由原会话 `sessions.release` 执行，§5.2）**、roles `install/list/get/grant/revoke`（G2）、settings `get/set`、app `quit/version`（`packages/desktop/src/shell/shared/contract.ts`）。每个 handler 校验**发送方 frame**（仅生产 renderer 页面 URL）并 redact 回复；无参方法拒绝携带 payload。
- **G-min loopback http 入口（诊断）**：`roledock-desktop-gmin` bin 保留为显式诊断入口——只代理 `externalSessions.list / roles.list / authorizations.submitHumanEvent` 三个操作，**不是通用 owner RPC 代理**；与 shell 生产确认页共享 `src/gmin/confirm.ts` 决策模块（entry/event_ref 一律在受信进程解析）。
- G0/G1 已实测的强制手段：单测断言清单封闭且无 rpc/call/invoke、合成授权 DTO 保留 `authorization_id` 而拒绝秘密字段、文本掩盖保留标签、发送方校验拒绝外来 frame；E2E 断言渲染层无 `process`/`require`、页面无 64-hex token、无参方法拒收 payload。

## 5. 写入幂等规则（G0 决策）

- 适用范围：**新增 GUI 写操作**（`proposals.submit`、`requests.cancelByOwner`，及未来的策略批量变更）。现有 18 个 SDK 操作不改语义、不追溯加 key。
- 输入带可选 `idempotency_key`（客户端生成的 UUID）；缺省时保持现行为（逐次执行）。
- 服务端按 `(operation, idempotency_key)` 存储首次结果；同 key 重放返回**原结果**并附 `idempotent_replay: true`（含对已终态资源的首次结果——如取消键重放返回首次取消；不产生第二次状态变更）；结果随审计事件保留，不设独立 TTL。
- 同 key 不同输入 → `IDEMPOTENCY_CONFLICT`（对齐 `externalSessions.register` 先例）。**不同 key** 对已终态资源的重复写（如再取消）不是幂等重放，按状态机拒绝（见 §6）。
- `sessions.anchor` 已带必填 `idempotency_key`（MCP 工具定义），本规则与其语义一致。
- **人类授权确认的稳定 action ID（G3）**：GUI 确认入口不再生成随机 `event_ref`。`event_ref` 为确认意图的确定性短哈希（external_session_id、role_id、capabilities、inherit、有效期小时桶，sha256 截断；`expires_at` 起点取整到下一个小时桶，保证同一次确认会话内重复提交得到同一 ref 与同一 `expires_at`）。同一意图的重复点击／刷新／窗口重开经 `authorizations.submitHumanEvent` 幂等重放同一条事件；改输入（如更长有效期）即新意图，与服务端 `IDEMPOTENCY_CONFLICT` 语义一致。entry/event_ref 仍只在受信进程解析。

## 6. owner 管理取消 `requests.cancelByOwner`（v2 对齐真实状态机）

以协议现有状态机为准（§1 所列 8 状态 + `execution_uncertain` 布尔子状态）。**owner 版不改变状态机，只新增允许的发起主体（owner principal）与独立审计**；状态迁移语义与现有会话取消守卫一致（`packages/core/src/requests/service.ts:436-484`）。

### 6.1 逐状态矩阵

| 当前状态 | 同键重放（§5） | 不同键发起取消 | 语义 |
| --- | --- | --- | --- |
| `accepted` | 返回首次取消结果 + `idempotent_replay:true` | **允许** → `cancelled`，`terminal_at` 写入，`cleanup_pending=1` | 排队建立期取消，宿主执行若尚未开始即不开始 |
| `queued` | 同上 | **允许**，同上 | 出队前移除 |
| `awaiting_input` | 同上 | **允许**，同上 | 澄清等待被管理取消；原会话随后的 `requests.reply` 走现有迟到/状态拒收（`INVALID_STATE_TRANSITION`），不复活请求 |
| `running` | 同上 | **仅当**该请求所用适配器已声明 cancel 能力；否则 `REQUEST_NOT_TERMINABLE`，请求**继续运行**、状态不变 | 与现有会话取消同一守卫；owner 不能绕过适配器能力边界 |
| `completed` | — | 拒绝：`REQUEST_NOT_TERMINABLE` | 终态不可逆；已有结果（若有）不受影响，也不可"再取消"或重试执行 |
| `failed` | — | 同上 | 终态 |
| `cancelled` | — | 同上 | 终态；重复取消（不同键）是对终态的无效写 |
| `expired` | — | 同上 | 终态 |

### 6.2 边界语义

- **取消能力不足**（running 且适配器未声明 cancel）：返回 `REQUEST_NOT_TERMINABLE` 并附当前状态；资源状态不变；GUI 显示"取消不可用（适配器未声明）"，不得显示已取消。
- **终态已生效而宿主尚未确认**：核心状态已是终态 → 拒绝取消；宿主侧后续产出按**迟到答案拒收**处理：不采纳、不写产物、不产生任何可发布结果（现有"迟到完成不能复活状态"语义的 owner 视角重述）。
- **`execution_uncertain=true`**：取消判定仍按上表当前状态执行；但不确定期内的正确动作是先对账（请求侧 lookup，对齐 `sessions.reconcile` 准则），**不得**以取消为名创建替代请求——新请求只能是新的用户/Agent 意图（计划 §14）。
- **`cleanup_pending` 与回收失败**：取消/到期置位后由协调器维护循环回收隔离分支与临时资源；回收失败**不改变终态**，经 `requests.listCleanup` 如实显示 pending/失败（§14"完成和清理失败可区分"）。
- **通知不是答案**：取消事实作为收件箱/收件条目的状态通知（state=`cancelled`）呈现；它**没有** artifact、没有 content_hash，不得进入 `documents.publish(adopt_artifact_id)` 链，也不构成任何发布权。
- **审计与主体**：独立审计事件 kind=`owner.request.cancel`，来源 owner，记录 request_id 与原因；不借用 `initiating` 会话身份、不经 `connection.call`、不伪造角色身份。
- **G0 范围**：本节为契约定档，操作在 G6 实现；但上述状态语义即为定档内容，不再留待实现时发明。

## 7. 服务生命周期与单 writer（G0 实测 + G1 定档）

- 每工作空间至多一个 service 进程持有 SQLite writer（`locking_mode=EXCLUSIVE`）；第二连接首语句 `errcode=5`（SQLITE_BUSY）→ `WORKSPACE_LOCKED`。G0 在 dev 与打包产物中均实测（自检 `sqlite_single_writer` 项）；G1 E2E 以 shell 双窗口复验同 writer。
- 桌面 shell 负责"发现/附着或启动"服务；已运行但不能证明归属的服务只显示连接冲突，不抢锁、不覆盖端点。
- **G1 生命周期定档（实现于 `packages/desktop/src/shell/supervisor.ts`，E2E `test/e2e-shell/`）**：
  - **打开已有工作空间**：owner-connection 文件校验（属主 + 0600 + 常规文件）→ 试连 `workspace.info`（3s）→ 成功 = 附着（owned=false，UI 明示"附着的外部服务"）；**权限不符/属主不符/凭据被拒（401）= conflict**，不附着不覆盖；端点存在但无响应（死亡端点）→ 允许安全启动——由 service 自身 `recoverStaleSocket` 守卫（只清同 uid 死 socket、拒绝活端点/非 socket 文件），任何覆盖尝试都会被确定性拒绝。
  - **新建**：预检目录可写 → 结构化参数 spawn（args 数组、不经 shell、锁定 Node 22.23.2、最小 env）→ 就绪判定 = owner 凭据**真实探活通过**（跳过崩溃残留的陈旧 owner 文件窗口）→ owned=true。
  - **关闭窗口**：保留 owned 服务后台运行（页面明示"关闭窗口不会停止该服务"）。
  - **退出应用**：默认停止全部 owned 服务（设置 `exitStopsOwnedServices` 可关）；**附着的外部服务绝不停止**。停止为有界停机：SIGTERM → 8s 宽限 → SIGKILL；**取消 UI 等待 ≠ 取消已提交动作**；宽限用尽强制结束时保留执行/回收不确定状态，下次启动对账，不为快速退出丢弃持久意图。
  - **服务崩溃**（owned 子进程异常退出）：状态 → disconnected 并显示原因；UI 重启可恢复，workspace_id 与数据不变（就绪探活跳过陈旧文件）。
  - **重复启动应用**：单实例锁（稳定 userData）聚焦原窗口，不启动第二个 writer。
  - **切换工作空间**：前台同时一个；被切换的 owned 服务保留后台运行，显式停止才回收。
- **ServiceClient 客户端等待期限**（G1，`packages/service`）：`call(op, input, { timeoutMs })` 默认 30s；超时销毁请求并拒绝本地 `ServiceRequestTimeoutError`——语义为"已提交动作可能仍在执行，须对账而非盲重试"。

## 8. 技术定档摘要（细则见 toolchain.md「P6-G0 桌面技术定档」）

- 容器：**Electron 44.9.3**（上一稳定大版本最新补丁；外壳自带 Node 24.22.0 **≠** 锁定 22.23.2，仅作 shell 与编排）。
- 服务运行时：**独立 Node 22.23.2**（官方 dist + SHA256 校验），dev 走 `.cache/runtime/`、打包为 `resources/runtime/node/node`；SQLite 始终运行在锁定 runtime（`node:sqlite`）。
- 渲染层：**无框架 TypeScript + esbuild 0.28.2**（唯一构建器）；严格 CSP；沙箱 + contextIsolation 默认开启。
- E2E：**@playwright/test 1.64.1**（`_electron.launch` 驱动真实窗口）。
- 打包：**electron-builder 26.18.0**；`dir` 目标 = 解压即跑开发产物（G0 已验证可运行并定位运行时）；**`.deb` 为唯一首发安装格式候选**（G7 出包验收）；不维护第二安装格式。

## 9. 原会话受信接入（G3 定档；详见 ADR-0014）

### 9.1 发现与登记

- **发现**：桌面受信桥经服务 trusted 面 `externalSessions.discover` 读取宿主候选（adapter `listHostSessions` port；zcode 实现为连接器 `zcode_list_sessions` → app-server `session/list`，真机 spike 实证为工作空间存储级枚举、零模型轮）。候选只含宿主会话元数据（ID/标题/状态/kind/updated_at/已登记标记），不含聊天正文。
- **登记**：GUI 选择候选（或粘贴引用，发现不可用时的后备）→ 受信桥调既有 trusted 面 `externalSessions.register`（仅 `host_session_id`；subject 来自受信 principal）→ 服务经 adapter `verifyExternalSession`（session/resume，零模型轮）验证后签发会话凭据。模型自报 host ID 不构成登记。
- **通道归属**：持久化桌面会话（`session_*`）与 app-server 实例内存会话（`sess_*`）结构性可辨（spike 实证后者跨实例不可 resume）；受管 consultation 仍走 `createSession` 沙箱路径。原会话接入不改变适配器能力声明（restricted 面用既有 external 声明；受管声明不变）。

### 9.2 会话凭据交接

- 登记成功返回的会话凭据由桌面受信主进程写入 `<root>/.roledock/mcp-session.env`（0600、O_NOFOLLOW、临时文件原子重命名）：`ROLEDOCK_SERVICE_SOCKET` / `ROLEDOCK_SESSION_TOKEN`。
- 用户在 ZCode 桌面会话的 MCP 配置中以 `ROLEDOCK_CREDENTIAL_FILE` 指向该文件（一次）；`roledock-mcp` 优先 env 凭据，缺省时读文件并执行与 owner-connection 同等的属主/0600/常规文件校验，不符即失败，不猜身份。
- v1：同一工作空间同一时刻一份会话凭据文件（最后登记生效）；重新登记时桌面重写内容，已配置的会话无需改 MCP 配置。

### 9.3 受信事件进度桥

- 桌面主进程桥：工作空间运行期间以受信连接轮询 `authorizations.pendingEvents`（默认 5s，工作空间非 running 暂停），对每条无有效授权的事件自动调既有 `authorizations.recordHuman`（幂等）。桥运行于受信主进程，凭据不跨桥。
- 桥只推进"事件 → 授权"。**显式锚定只能由原会话 Agent 经会话面 `sessions.anchor` 发起**；GUI/桥无 anchor 通道。桥失败写入诊断，不静默。
- GUI 进度展示按 `authorizations.confirmations` 分阶段呈现：事件已保存 → 授权已生成 → 等待 Agent 锚定 → 载入中/uncertain → active/failed；"确认不是绑定"全程明示；需要用户回到原会话时给出明确提示。
