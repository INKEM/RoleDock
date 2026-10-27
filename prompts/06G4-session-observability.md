# P6-G4：会话观察、撤销与恢复

前置：P6-G3 独立验收 PASS。

先读 COMMON、AGENTS、开发蓝图、toolchain、[桌面 GUI 计划](../docs/DESKTOP_GUI_PLAN.md) §5、§6、§12、ADR-0013及前序验收。以当前代码和已定档契约为准；只执行本子阶段。

## 工作

1. 按 G0 契约增加 owner 的 binding/attempt/load 分页视图，展示 generation、前任、知识版本、授权来源、实际能力与载入确认。
2. 区分连接状态与 active/superseded/released/revoked/expired/uncertain；实现 owner 撤销及影响预览，释放仍由原会话执行。
3. 使用有界轮询、观察时间和版本，防止跨工作空间迟到响应覆盖。现有 admin.events 只用于 outbox 诊断，不假装通用事件总线。
4. 验证服务重启后受信重登记恢复绑定不加代次；takeover 保留旧已接收快照，release/revoke/expiry 按现有规则撤销派生任务；显示 cleanup_pending 和执行不确定。

## 退出条件

GUI 能解释当前会话权限、继承来源、失败原因和下一恢复动作，无需查看数据库；撤权生效和外部回收确认分开。不做聊天历史查看器。

## 交付与停止点

写 `docs/phase-reports/P6-G4-development.md`，状态“待独立验收”；记录实际 HEAD／工作区、源码与契约变化、命令／退出码、失败／跳过项和证据位置。依赖变动先更新 toolchain，架构／权限变化先补 ADR。交独立验收 Agent 按 REVIEW 形成 `P6-G4-review.md`。本阶段完成后停止，不自动进入下一阶段、提交或远程发布。
