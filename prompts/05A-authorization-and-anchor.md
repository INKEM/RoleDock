# P5-A：受信授权与外部会话显式锚定

前置：P5-R 已独立验收，P1–P4 当前复验 PASS；P5 的真实 Harness 缺口可以保留。读取 COMMON、桌面实施计划、ADR-0007、身份与适配规范。

先固化 ExternalSession、RoleAuthorization、AnchorAttempt、SessionBinding 的 Schema、迁移、输入输出、错误码、事务与幂等规则。随后实现共享单协调器服务、受信宿主会话／人类授权事件接入接口，以及 sessions.anchor/binding/reconcile/release 和最小 MCP 会话工具。

Agent 只能消费本连接的已有具体授权。所有者 GUI／受信人类事件接入组件签发授权，普通 Agent 工具不能签发授权、切换 role_id、打开写库、调用 WorkspaceAdmin 或测试夹具。既有明确授权不要求重复确认。

锚定当前外部会话；材料载入确认后才 CAS 激活。首次、接任、恢复、撤销、释放、授权过期、跨会话、跨工作区、重复键、知识变化、代次竞争与中途退出均需有实际状态断言。仅 Mock 验证不能计真实宿主通过。

核查官方 MCP SDK 后精确固定版本，并更新 toolchain。写 P5-A 开发报告（待独立验收），通过后停止，不自动选择或使用真实宿主。
