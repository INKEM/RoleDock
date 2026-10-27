# P6-G1：桌面外壳与服务生命周期

前置：P6-G0 独立验收 PASS。

先读 COMMON、AGENTS、开发蓝图、toolchain、[桌面 GUI 计划](../docs/DESKTOP_GUI_PLAN.md) §4、§9、ADR-0013及前序验收。以当前代码和已定档契约为准；只执行本子阶段。

## 工作

1. 按 G0 定档实现 main/preload/renderer/runtime 边界，模块化 G-min，建立导航壳、统一错误与具名 IPC；不新建另一套 core。
2. 实现工作空间 supervisor、服务发现／附着／启动、重复应用启动处理、后台／退出策略和重连。只管理自己拥有的进程，不覆盖外来端点。
3. 保持独立锁定 Node 服务；owner 凭据在受信层，渲染层无写库、Shell、通用 RPC 或 bearer。保留 G-min 诊断入口时明确其访问边界。
4. 补 ServiceClient 请求等待期限和有界停机：取消 UI 等待不等于取消已提交动作，停机超时保留对账状态。验证两窗口一个 writer、关闭窗口不撤权、重启 UI 附着原服务、异常端点拒绝、服务退出清理和未授权 IPC 拒绝。

## 退出条件

从桌面开发入口打开窗口并启动／附着 mock 服务，无需手输 owner 文件；单 writer 和恢复证据齐全。不做真实接入业务或其余页面。

## 交付与停止点

写 `docs/phase-reports/P6-G1-development.md`，状态“待独立验收”；记录实际 HEAD／工作区、源码与契约变化、命令／退出码、失败／跳过项和证据位置。依赖变动先更新 toolchain，架构／权限变化先补 ADR。交独立验收 Agent 按 REVIEW 形成 `P6-G1-review.md`。本阶段完成后停止，不自动进入下一阶段、提交或远程发布。
