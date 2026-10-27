# ADR-0014：原 ZCode 桌面会话受信接入与凭据交接

日期：2026-10-27

状态：**候选定档（开发方，P6-G3）；待独立验收**。沿用 ADR-0007/0009/0011/0012/0013 的身份、授权与执行边界；不授予 GUI 任何签发、锚定或发布权。

关联：[桌面 GUI 分阶段计划](../DESKTOP_GUI_PLAN.md) §11、[ADR-0013](0013-desktop-orchestration-and-owner-views.md) 决策 6、[desktop-gui-contract](../spec/desktop-gui-contract.md) §9、发现能力 spike 证据（`phase-reports/evidence/2026-10-27-p6-g3/spike-discovery/`）。

## 背景

G2 结束时，真实 ZCode 工作空间已可从 GUI 启动，但"用户已在 ZCode 桌面打开的原会话"没有任何产品接入路径：`externalSessions.register` 只被测试 bin 调用；G-min 存储人类事件后，产品中没有任何受信组件执行 recordHuman；会话 MCP 凭据没有产品化的分发方式。P6-G3 提示词要求识别真实原会话、补受信事件进度桥、并把会话凭据只交给该会话的工具启动器。

2026-10-27 真机 spike 实测（零模型轮）确认：

1. app-server `session/list` 是工作空间存储级枚举：全新实例零附着即返回该工作空间全部持久化会话（含用户正在使用的桌面会话）。
2. 跨实例 `session/resume` 对持久化桌面会话（`session_*`）成功；连接器注释"list 不显示未附着会话"对当前 CLI 版本不成立。
3. app-server `session/create` 造出的 `sess_*` 会话是实例内存态，不落数据库，实例退出后跨实例不可 resume——与 B5 受管 spawn 生命周期一致。

## 决策

1. **原会话接入走受信登记 + 存储发现，不建第二条主会话通道。** 桌面受信桥经服务 trusted 面 `externalSessions.discover`（新，只读）获取宿主候选列表（adapter `listHostSessions` port → 连接器 `zcode_list_sessions` → app-server `session/list`），用户在 GUI 选择自己的原会话后由受信桥调既有 `externalSessions.register`；身份经 `verifyExternalSession`（session/resume，零模型轮）验证。粘贴非敏感会话引用保留为发现不可用时的后备入口。不需要在 adapter/launcher 层拆分主会话与受管执行通道：两类会话在宿主侧结构性可辨（持久化 `session_*` vs 实例内存 `sess_*`），受管 consultation 仍走 `createSession` 沙箱路径，非受管适配器保持 restricted 声明，能力声明无变化。
2. **受信主体与凭据交接。** 桌面主进程对每个运行中的工作空间以 owner 凭据调 `connections.trust` 取得受信连接（subject 固定为该工作空间的桌面受信桥身份，ceiling 为协议能力注册表的名义上限）。登记成功后，服务返回的会话凭据（session bearer + socket 路径）由受信桥写入工作空间 `<root>/.roledock/mcp-session.env`（0600、O_NOFOLLOW、原子重命名，与 owner-connection 同级信任边界）。用户在 ZCode 桌面会话的 MCP 配置中以 `ROLEDOCK_CREDENTIAL_FILE` 指向该文件一次；之后每工作空间重新登记时桌面重写文件内容，已打开的会话无需改配置。`roledock-mcp` 优先读环境变量凭据，缺省时读该文件并执行同等 0600/属主校验；文件缺失或权限不符时如实失败，不猜测身份。v1 约束：同一工作空间同一时刻只有一份会话凭据文件（最后登记的会话生效），与"一个前台工作空间"的产品边界一致。
3. **受信事件进度桥。** 桌面主进程内置事件桥：工作空间运行期间以受信连接轮询 `authorizations.pendingEvents`（新，trusted 读；subject 来自受信主体，输入强制为空，模型与普通会话不可调用），对每条"事件已存储但尚无有效授权"的记录自动调用既有 `authorizations.recordHuman`（幂等，同 event_ref 重放返回原授权）。桥只推进"确认→授权"这一步；**显式锚定仍只能由原会话 Agent 经会话面调用 `sessions.anchor`**，GUI 与桥都没有 anchor 通道。桥失败记录到诊断视图，不静默、不重写成成功。
4. **确认幂等（稳定 action ID）。** G-min 随机 `event_ref` 缺陷在本阶段修复：`event_ref` 改为确认意图的内容寻址短哈希（external_session_id、role_id、capabilities、inherit、expires 桶），expires 取整到小时桶——同一意图的重复点击、刷新、窗口重开经 `submitHumanEvent` 幂等重放同一条事件，不产生重复有效授权或新一代；改变有效期等输入即新意图，冲突按 `IDEMPOTENCY_CONFLICT` 如实报错。
5. **owner 进度视图。** `authorizations.confirmations`（新，owner 读）投影每个已登记会话的确认链：事件 → 授权（含撤销）→ 最新锚定尝试（prepared/loading/uncertain/active/failed 与错误消息层）→ 绑定（代次、状态）。GUI 按"事件已保存 / 授权已生成 / 等待 Agent 锚定 / 载入中 / active / failed / uncertain"分开展示，"确认不是绑定"贯穿文案；观察时间与分页遵守 desktop-gui-contract §2.1。

## 不做的事

- GUI/桥不调用 `sessions.anchor`，不代 Agent 锚定；"等待 Agent"是明确显示状态。
- 不自动接任下一主实例，不读取宿主私人聊天正文；discover 只返回宿主会话元数据（ID、标题、状态）。
- 不扩大适配器能力声明：原会话接入使用既有 `current_session_identity`/`human_authorization_events`/`load_materials`/`reconcile_load` 声明，受管隔离声明不变。
- 不实现通用事件总线；进度视图为有界轮询。

## 预期代价与验证

新增 3 个 owner/trusted 只读或低权操作与 3 个协议 Schema、桌面受信桥与凭据文件写入、`roledock-mcp` 凭据文件回退、连接器 `zcode_list_sessions` 工具。验证：服务集成测试（投影、主体绑定、三面权限矩阵、幂等重放）、shell E2E（mock 全链零模型）、真实 ZCode 桌面原会话证据（GUI 点击 → 事件 → 授权 → Agent 工具调用 → 载入 → active binding，同会话 ID 前后一致）。本 ADR 通过独立验收前，能力声明不翻转。
