# P5-A：受信授权与外部会话锚定协议

日期：2026-10-14；实施状态：[P5-A 独立验收本地 PASS](../phase-reports/P5-A-review.md)。ADR-0009 固化本阶段选择，真实宿主证明留待 P5-H。

## 主体与入口

`ExternalSessionAuthority` 是受信本地所有者/宿主接入控制面，不能注册为 Agent 工具。它从已打开的 Coordinator 复用存储，且需要匹配的 HarnessAdapter。`WorkspaceAdmin.forCoordinator` 只用于受信所有者复用同一持锁句柄。原 Coordinator 的18个接口继续是受信本地 SDK，不提供远程身份认证；新增会话接口由 `SessionConnection.call` 暴露，并固定登记后的外部会话主体。

`@roledock/service` 使用单协调器和 Linux Unix socket（0600）。所有者 bearer 只用于控制面；所有者签发指定连接主体和能力上限的 trusted bearer；trusted 接入组件经 adapter 验证已有宿主会话后领取独立 session bearer。bearer 为随机256位，不存角色知识，不放入 Agent 参数、日志或 MCP 工具返回。服务重启后 bearer 失效，受信组件重新登记同一主体/会话后查询原绑定，代次不增。没有 bearer 的调用被拒绝。威胁边界不包含能读取同一操作系统用户全部文件/内存的恶意本地代码。

trusted 连接只可 register 和 recordHuman，不能调用所有者或角色工具。普通连接不能调用 WorkspaceAdmin、角色安装、知识导入导出、任职捷径、数据库、请求执行引擎、sessions.open 或授权签发/撤销；也不能在输入中提供调用者 session_id/workspace_id。documents.list 的 role_id、documents.read/propose 的目标角色仅指定被访问对象，不改变调用身份。所有者和会话的操作白名单分别固定。

## 新对象（Schema 是代码契约权威）

| 对象 | 固定信息与约束 |
| --- | --- |
| ExternalSession | 外部会话ID、工作空间、adapter/host ID、连接主体、所有者能力上限、状态/创建时间；adapter+host 唯一；登记本身不授予角色 |
| RoleAuthorization | 授权ID、外部会话/主体、角色包名称/版本/哈希、能力范围、initialize/takeover 意图、主generation/instance基线、到期/撤销、来源引用；不存原始私人消息 |
| AnchorAttempt | 本外部会话范围的幂等键/内容哈希、授权、固定材料哈希、载入键、代次/知识基线、prepared/loading/uncertain/active/failed、确认/错误；一个会话至多一个未决尝试 |
| SessionBinding | 外部会话→核心session/instance/role/generation/授权、active/superseded/released/revoked/expired、来源和实时能力；每外部会话终身至多一个绑定，释放后换角色须用新聊天 |

四对象 Schema 和 TS 镜像见 packages/protocol；会话操作输入统一由 session-operation Schema 校验，未知字段拒绝。控制面由 service-control-operation 和 external-registration Schema 校验；anchor-material Schema 校验角色指令/模板/输出schema闭包、共享文档正文/来源和已提交 checkpoint；每次重新准备均保存独立anchor_loads记录，保留旧材料哈希/载入键/已确认来源。材料不包含授权凭据、私人聊天或活进程。旧 checkpoint 的私密文档快照引用过滤后才载入；摘要/待办/决策须是经正常知识提交流程保存的材料。

## 控制面输入/输出

| 操作 | 主体 | 输入 | 输出与幂等 |
| --- | --- | --- | --- |
| connections.trust | 所有者 service | subject, capability_ceiling | 新 trusted credential；该身份/上限不接受后续RPC覆盖 |
| externalSessions.register | trusted service | host_session_id | adapter验证host/主体；返回 external_session + session credential。core register由受信控制器传 connection_subject/ceiling；同adapter+host+主体+ceiling返回原ExternalSession，否则 IDEMPOTENCY_CONFLICT |
| authorizations.recordHuman | trusted | external_session_id, event_ref | adapter读取可验证原始人类事件；工作空间/主体/host/ref全匹配；返回RoleAuthorization。模型/工具/引用文字不形成事件。受信通道还须属于该主体 |
| authorizations.recordOwner | 所有者 | external_session_id, event_ref, actor_id, role_id, capabilities, inherit, expires_at | 明确 owner-selection 降级来源；不是纯会话授权证据 |
| authorizations.revoke | 所有者 | authorization_id | 幂等撤销，立即撤权/失效/撤销未完成任务，再按能力回收；返回历史授权及revoked_at |

来源幂等范围为(外部会话,来源kind,event_ref)，同内容返回原授权和原基线，同来源不同内容冲突，不重新采样基线。目标角色缺失返回 NOT_FOUND；不猜角色。角色有历史generation时要求takeover，含已释放角色的知识接续；未明确继承意图返回 PERMISSION_DENIED。能力不得超过登记的上限；requested_capabilities不参与授予。

## 普通会话操作

| 操作 | 输入 | 返回与事务规则 |
| --- | --- | --- |
| authorizations.get | {} | 仅本连接未撤销且未到期的具体授权；不返回其他会话授权或私人原文 |
| sessions.anchor | authorization_id, idempotency_key | AnchorResult {attempt,binding}；同键同内容恢复/返回原尝试，同键不同授权冲突；未决尝试必须先对账。跨会话/工作空间授权拒绝，零任职变化 |
| sessions.binding | {} | {binding:null或SessionBinding}；恢复已有绑定的查询，不调用宿主nativeResume，不增generation |
| sessions.reconcile | attempt_id | 只查询本连接原尝试；返回AnchorResult；不盲目重复载入或接任 |
| sessions.release | {} | 无绑定时可取消未决尝试，有绑定时失效并撤销派生任务；返回最新binding。重复释放无新副作用，不关闭用户外部聊天 |

其余9个会话工具为documents.list/read/propose/publish、requests.create/get/reply/cancel、artifacts.read，核心session_id由连接注入。MCP仅提供这14个工具；stdio进程通过ServiceClient连接已有服务，不单独开写库。

## 锚定状态机、CAS与恢复

1. 校验具体授权的工作空间、连接、有效期、范围、契约和主指针基线。必须具备授权与策略交集内的documents.read才可载入知识。
2. 完整材料按哈希落内容存储，attempt prepared落库；load_key来自核心，和Agent幂等键分离。
3. 外部动作前写loading；调用loadExternalMaterials在原会话载入固定正文和能力范围，绝不调用createSession完成锚定。
4. 确认中的host_session_id、load_key、content_hash、正整数load_version全部匹配后，在激活事务重验授权、generation、instance、knowledge_revision和当前策略，再CAS主指针，写session/instance/binding和active。载入未确认时旧主指针不动。接任使旧instance失去发布权，旧binding展示superseded。
5. 知识变化最多重新准备/载入三次（新材料/新load_key），保持授权原generation/instance基线。代次竞争失败GENERATION_CONFLICT，不能自动覆盖胜者；要求新接任授权。
6. 重启后prepared可载入，loading/uncertain只查询原load_key。loaded必须返回同键/哈希/会话确认；absent是宿主可靠的“未发生”证据，可按原键载入；unknown、暂时查询错误或缺查询能力保持uncertain，零新任职。已active重试返回历史尝试与**实时binding状态**，该历史activation不意味着撤销后仍有权。

确定失败返回attempt.failed/error，未确认外部动作返回uncertain；这些都是状态结果而非假成功。MCP对failed返回isError，并保留结构化结果；uncertain必须继续对账。错误码复用 PERMISSION_DENIED、NOT_FOUND、VALIDATION_FAILED、IDEMPOTENCY_CONFLICT、GENERATION_CONFLICT、REVISION_CONFLICT、INVALID_STATE_TRANSITION、ADAPTER_CAPABILITY_MISSING、INTERNAL；无新错误码枚举。

## 生命周期与独立任务

有效能力=原材料载入范围∩授权范围∩实时工作空间策略；分支再与固定任务scope取交集。原SDK与底层动作同样检查外部绑定授权，不能绕过连接门面。撤销、到期或release立即阻止后续动作；当前主指针置null，generation保持最后已激活值。所有者服务周期检查到期，单次操作也检查实际时间。到期维护与耗时外部轮次分离，不因某个runTurn挂起阻塞其他授权到期。ROLE_UNINITIALIZED表示没有可服务主实例（新角色或释放/撤权后），新锚定接续已提交知识成为generation+1，不复活前任。

单纯接任不撤销旧绑定已接收的独立任务；其目标instance/generation/快照固定。release/revoke/expiry撤销该绑定作为发起者或目标派生的非终态请求，失败状态、错误及回收pending同事务持久化；迟到结果不进入artifact/inbox。执行每次花费前和异步返回后检查原任务授权与实时策略。宿主不支持cancel时不宣称已停止；执行结果不确定标记及cleanup_pending保留至实际对账/回收。已提交文档和已完成artifact不被撤回。

服务周期驱动持久outbox与请求阶段，重叠投递复用既有领取/执行键；服务退出停止接入和worker后释放唯一writer。SIGKILL留下的本用户socket在取得writer锁后探测：只有可靠ECONNREFUSED且inode/dev未变时回收；活socket、非socket文件和symlink拒绝覆盖。原CLI仍是停机维护入口，服务运行时直接打开同工作空间明确WORKSPACE_LOCKED；集成方使用ServiceClient，CLI远程模式不在P5-A范围。

## 适配证据

新增external能力：current_session_identity、human_authorization_events、load_materials、reconcile_load。相应可选方法 verifyExternalSession/readHumanAuthorization/loadExternalMaterials/lookupExternalLoad 见类型端口。缺少声明或方法不调用并返回明确缺口。原Mock/bridge请求契约保持；bridge尚不具备已有会话接入，不能当作锚定成功证据。

Mock事件与固定回答测试、持久fixture的SIGKILL恢复、真实MCP子进程仅证明本地状态及进程边界。P5-H须由已授权真实宿主实现该端口并证明原会话的真实材料消费与角色工作；MCP bearer认证本身不能证明人类来源。
