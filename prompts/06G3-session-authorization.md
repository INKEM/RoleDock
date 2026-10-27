# P6-G3：原 ZCode 桌面会话授权与显式锚定

前置：P6-G2 独立验收 PASS。

先读 COMMON、AGENTS、开发蓝图、toolchain、[桌面 GUI 计划](../docs/DESKTOP_GUI_PLAN.md) §2、§5、§11、ADR-0013及前序验收。以当前代码和已定档契约为准；只执行本子阶段。

## 工作

1. 识别用户已在 ZCode 桌面打开的原会话，以受信主体登记并向该会话工具启动器分发独立凭据；不由模型自报 host ID 决定身份。
2. 验证真正桌面主会话通道与受管请求通道的能力和归属，必要时先修订 ADR／适配契约再在 adapter/launcher 路由，非受管绝不继承 full 声明。
3. 复用 G-min 确认：角色、能力差异、initialize/takeover、有效期、来源、稳定 action ID；处理事件已存但授权未生成时的重复点击。
4. 补受信事件进度桥，自动推进 recordHuman；Agent 在原会话显式调用 sessions.anchor，GUI 仅观察。不得 GUI 冒充 Agent 调 anchor 或把确认视为 active。
5. 采集真实桌面点击、原 host ID、事件、授权、Agent 工具、载入确认、active binding 关联证据；覆盖知识漂移、代次竞争、跨会话／失效／超范围和不确定恢复。

## 退出条件

同一真实 ZCode 桌面原会话完成锚定且角色工作前已载入。HTTP 直调、测试连接器新建主会话或仅数据库记录不能替代。接口不足时记录明确阻塞，不伪造成功。

## 交付与停止点

写 `docs/phase-reports/P6-G3-development.md`，状态“待独立验收”；记录实际 HEAD／工作区、源码与契约变化、命令／退出码、失败／跳过项和证据位置。依赖变动先更新 toolchain，架构／权限变化先补 ADR。交独立验收 Agent 按 REVIEW 形成 `P6-G3-review.md`。本阶段完成后停止，不自动进入下一阶段、提交或远程发布。
