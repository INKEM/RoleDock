# P6-G2：工作空间、接入预检、角色与策略

前置：P6-G1 独立验收 PASS。

先读 COMMON、AGENTS、开发蓝图、toolchain、[桌面 GUI 计划](../docs/DESKTOP_GUI_PLAN.md) §3、§5、§10、ADR-0013及前序验收。以当前代码和已定档契约为准；只执行本子阶段。

## 工作

1. 实现创建／打开／最近工作空间、原生目录选择、工作空间身份校验和错误恢复；移除最近记录不删除项目。
2. 实现真实 ZCode 服务 launcher 与接入配置：CLI、连接器、外部 credential helper 引用、模型标识、受管出口集合；不携带个人路径／账户材料。
3. 预检 Node/CLI/connector/bwrap/userns/目录，默认只读不消费模型；真实连接测试为单独用户动作。
4. 实现角色包安装、职责／模板／输出 Schema 详情、包哈希、当前主指针和需求／策略对照；安装不自动 grant，查询 initialized 不等于当前可服务。

## 退出条件

用户从 GUI 建立真实配置工作空间、安装任意 custom-role 并编辑策略，无需 CLI；无依赖时显示受限，选择角色不打开会话。锚定留到 G3。

## 交付与停止点

写 `docs/phase-reports/P6-G2-development.md`，状态“待独立验收”；记录实际 HEAD／工作区、源码与契约变化、命令／退出码、失败／跳过项和证据位置。依赖变动先更新 toolchain，架构／权限变化先补 ADR。交独立验收 Agent 按 REVIEW 形成 `P6-G2-review.md`。本阶段完成后停止，不自动进入下一阶段、提交或远程发布。
