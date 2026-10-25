# ADR-0009：受信连接、授权和同会话锚定

日期：2026-10-14；状态：已接受并实施，[P5-A 独立验收本地 PASS](../phase-reports/P5-A-review.md)。

## 决策

共享服务是每工作空间唯一写入者。所有者控制面、受信宿主事件面、普通会话面通过独立不可猜测连接凭据分离；凭据由服务所有者创建，不从 Agent 参数推导。普通会话面只提供白名单操作，调用身份由服务保存的 ExternalSession 得出，禁止 session_id/workspace_id/调用者 role_id 覆盖。MCP 是该会话面的 stdio 客户端，不打开 SQLite，不提供授权签发或管理员工具。受信本地所有者代码仍可使用原 SDK/WorkspaceAdmin；它们不作为 Agent 认证边界。

受信适配器验证已有宿主会话及原始人类事件引用，返回结构化授权事实。仅保存来源引用及授权范围，不存私人原始消息。所有者可明确登记 owner-selection 授权作为降级。普通会话不能注册身份或递交“用户说过”的文字。授权固定工作空间、连接主体、外部会话、角色包哈希、主指针基线、继承意图、能力上限和到期时间；同一来源重复登记返回同一授权，不更新基线。

锚定材料完整内容寻址持久化，prepared→loading 的意图在外部动作前落库。在原宿主会话按 load_key 载入，并返回 session/hash/load_key/version 确认；只有完全匹配确认后事务 CAS 激活。loading/uncertain 重启只查询原 load_key；查询确认 absent 才能使用原键发起尚未发生的载入；unknown 保持 uncertain。知识漂移产生新材料和新载入键（最多三次），主代次漂移失败，不自动接任竞争胜者。每个外部会话终身至多一次角色绑定，release 后不在同一聊天换角色。

绑定的有效能力取授权、实时工作空间策略及固定载入能力上限的交集。撤销或到期阻止所有后续角色动作（含直接 SDK 路径），当前主指针置空并保留 generation 单调性；不恢复前任。release 同样撤销本绑定的动作权限。绑定历史与已提交知识保留。接任不撤销已经接收的独立任务：其接收快照保持不变。release/revoke/expiry 则撤销该绑定作为发起者或目标所派生的非终态任务，终态失败并拒收迟到答案；取消和资源回收依适配能力执行，未确认外部结束时保留 execution_uncertain/cleanup_pending。分支检查接收时绑定的授权，而不是自动迁移到新主授权。

服务使用权限 0600 的 Unix socket 和每连接独立 bearer；这是首个 Linux 本地可运行传输，P5-A 不宣称 GUI IPC/真实宿主已交付。服务驱动 outbox，并在重启后对持久请求阶段继续查询/回收；MCP 不提供内部执行入口。

## 影响

新增四个协议对象、输入 Schema、迁移 6、已有会话适配口、core 受信连接门面、service/mcp 两个可运行包。已释放 RoleHead 的 current_instance_id 允许 null；generation 仍表示最后已激活代次。未初始化或不可服务角色的新请求返回 ROLE_UNINITIALIZED。不变更工具链 Node/SQLite 基线。
