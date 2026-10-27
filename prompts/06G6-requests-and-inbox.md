# P6-G6：请求、产物与收件箱

前置：P6-G5 独立验收 PASS。

先读 COMMON、AGENTS、开发蓝图、toolchain、[桌面 GUI 计划](../docs/DESKTOP_GUI_PLAN.md) §5、§6、§14、ADR-0013及前序验收。以当前代码和已定档契约为准；只执行本子阶段。

## 工作

1. 实现 owner 请求／产物／预算／回收详情和分页，展示发起／目标、固定代次快照、真实正文哈希、inbox 与候选状态。
2. 补固定会话身份的收件箱／候选读取工具时先更新 Schema、服务白名单、MCP 与测试；普通会话没有 owner 操作。
3. 如提供 GUI 管理取消，使用独立 owner 操作与审计，不能借发起 session 身份；补充回复由原发起会话执行，GUI 不自建聊天。
4. 结果只建议采纳／转到原会话，由当前有权主角色 documents.publish(adopt_artifact_id) 正式采用；超时／撤销／代次冲突如实呈现。
5. 验证十实际重叠请求、独立结果／权限、零主聊天注入、迟到拒收、预算支出前校验和回收状态；用量未知不显示0。

## 退出条件

用户从 GUI 看完整请求到真实答案、当前角色显式采纳后的确切修订，无需 admin CLI；completed、已读和 adopted 分开。不加任务 DAG 或嵌套自动请求。

## 交付与停止点

写 `docs/phase-reports/P6-G6-development.md`，状态“待独立验收”；记录实际 HEAD／工作区、源码与契约变化、命令／退出码、失败／跳过项和证据位置。依赖变动先更新 toolchain，架构／权限变化先补 ADR。交独立验收 Agent 按 REVIEW 形成 `P6-G6-review.md`。本阶段完成后停止，不自动进入下一阶段、提交或远程发布。
