# P6-G：桌面管理 GUI 总入口

当前前置已满足：[P5-H B5-4 独立验收](../docs/phase-reports/P5-H-b5-4-review.md)于 2026-10-25 判定 PASS，G01-Z03 关闭、P5-H 解除 BLOCKED、P5 整体通过。G-min 已交付，但不是完整桌面应用。

先读 COMMON、最新 AGENTS、[桌面 GUI 计划](../docs/DESKTOP_GUI_PLAN.md)、ADR-0013、toolchain 与当前源码。P6-G 拆为下列子阶段，一次只执行一个，独立验收后再进入下一个；本入口不是一次实现全部页面的授权提示。

| 子阶段 | 提示词 | 目标 |
| --- | --- | --- |
| G0 | [06G0-contract-and-spike](06G0-contract-and-spike.md) | 技术探针、操作契约、版本定档 |
| G1 | [06G1-shell-and-runtime](06G1-shell-and-runtime.md) | 外壳、IPC、唯一服务、进程生命周期 |
| G2 | [06G2-workspaces-and-roles](06G2-workspaces-and-roles.md) | 工作空间、接入预检、角色与策略 |
| G3 | [06G3-session-authorization](06G3-session-authorization.md) | 原 ZCode 桌面会话、确认与 Agent 锚定 |
| G4 | [06G4-session-observability](06G4-session-observability.md) | 会话／载入视图、撤销、恢复观察 |
| G5 | [06G5-knowledge](06G5-knowledge.md) | 知识、历史、候选、迁移 |
| G6 | [06G6-requests-and-inbox](06G6-requests-and-inbox.md) | 请求、产物、收件箱和明确管理操作 |
| G7 | [06G7-release-validation](06G7-release-validation.md) | 真实桌面全链、恢复、安装包和总体验收 |

若用户仅说“开始 P6-G”，从 **G0** 执行。若明确给定子阶段，先核对其前置报告。GUI 管理外部 Harness，会话仍属于 ZCode；不自建聊天宿主，不重写已通过的锚定／请求状态机，不以 owner 凭据冒充角色发布。

各阶段开发报告为 `P6-Gn-development.md`（待独立验收）、独立报告为 `P6-Gn-review.md`。G7 通过后提交 P6-G 总体验收材料，整体 PASS 才进入 P6-R。未验证平台和操作如实标注，不自动提交或远程发布。
