# P6-G0：技术探针与 GUI 操作契约

前置：P5-H B5-4 PASS；G-min PASS。

先读 COMMON、AGENTS、开发蓝图、toolchain、[桌面 GUI 计划](../docs/DESKTOP_GUI_PLAN.md) §4、§5、§8、ADR-0013及前序验收。以当前代码和已定档契约为准；只执行本子阶段。

## 工作

1. 冻结当前 HEAD／工作区；核对 desktop/service/mcp/zcode 的真实能力，不把 admin.events 当完整订阅，也不假定已有 owner 文档／绑定／请求详情。
2. 优先验证 Electron + TypeScript UI + 独立 Node 22.23.2 服务；用实际窗口、IPC、目录选择、SQLite、MCP 子进程及打包路径探针完成选型。需要备选时比较成本，最终只定档一套方案。
3. 为 owner 读模型、渲染层具名接口、可见性、管理取消、候选提议和幂等逐项定义契约；正式角色发布仍走原会话。
4. 按官方接口核查并精确固定新增依赖、构建器和 E2E 工具，更新 toolchain 和 ADR-0013。探针使用临时 mock 工作空间，不发送真实模型任务。

## 退出条件

探针可运行且打包后能找到固定运行时；渲染层无凭据／任意 RPC；操作映射与可见性完整；单 writer 和生命周期有实测。交付契约／技术定档，不做五页面。

## 交付与停止点

写 `docs/phase-reports/P6-G0-development.md`，状态“待独立验收”；记录实际 HEAD／工作区、源码与契约变化、命令／退出码、失败／跳过项和证据位置。依赖变动先更新 toolchain，架构／权限变化先补 ADR。交独立验收 Agent 按 REVIEW 形成 `P6-G0-review.md`。本阶段完成后停止，不自动进入下一阶段、提交或远程发布。
