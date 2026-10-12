# AGENTS.md — RoleDock 仓库开发指令

RoleDock 是一个通用 Agent 角色协议与参考运行时：支持自定义角色、文档化知识、会话继承和跨 Harness 的独立协作。开发 Agent 在本仓库工作前，先读 `docs/DEVELOPMENT_PLAN.md`（蓝图）、`docs/toolchain.md`（环境基线）与最新阶段报告 `docs/phase-reports/`。

## 命令

```bash
nvm use           # Node 22.23.2（.nvmrc；engine-strict 已开启）
npm ci            # 按锁文件精确安装
npm run build     # tsc -b（project references，按依赖序）
npm run typecheck # tsc -b --force + tsconfig.check.json（src+tests 全量 noEmit 检查）
npm test          # build + vitest run（全部 130+ 测试）
npm run check     # typecheck → test，提交前门禁
```

CLI 本地运行：`node packages/cli/dist/bin.js --help`（先 `npm run build`）。

## 仓库结构

- `packages/protocol` — JSON Schema（draft 2020-12）、TS 类型镜像、错误码注册表、ajv 校验。Schema 是契约的代码侧权威。
- `packages/core` — 协调器与状态层。P2 已实现：角色包加载/安装/查询（`WorkspaceStore` 带校验和迁移、单协调器独占锁、事务）、能力策略与 `WorkspaceAdmin` 所有者入口、版本文档（list/read/propose/publish + 读取回执 + 可见性矩阵）、CheckpointBuilder、knowledge.export/import。`@roledock/core/testing` 是**仅测试夹具入口**（建立主实例/会话）；生产会话创建在 P3（sessions.open），夹具不是公开权限面。
- `packages/cli` — `roledock` 命令行；默认人类可读，`--json` 输出机器信封；退出码 0 成功 / 1 运行错误 / 2 用法错误。已接通：`roles install/list/resolve`、`admin policy/grant/revoke`、`documents list/read/propose/publish`（需 `--session`）、`knowledge export/import`。
- `adapters/`、`examples/` — 目录约定（P1/P5 交付），不放置不可运行的空壳包。
- `docs/spec/` — 规范（对象与状态机、身份与权限、SDK 操作、适配契约）。
- `docs/adr/` — 架构决策记录；改架构先补 ADR。
- `tests/` — conformance（跨包一致性）、integration（子进程）、fixtures（合法/非法样例）。

## 硬性约束（违反即返工）

1. **核心无业务角色**：`packages/*/src` 不得出现任何具体角色名称或角色枚举（builder/reviewer/explainer 只是示例数据）；角色是包数据，不是代码。
2. **能力声明 ≠ 授权**：`requested_capabilities` 是需求声明，权限由工作空间策略决定；角色包永不自行授予执行或发布权。
3. **身份来自会话绑定**：客户端自报的 role_id 不用于授权；正式发布校验所有权、当前主实例、代次与 expected_revision。
4. **未实现不伪装**：未交付的功能必须以 `NOT_IMPLEMENTED` 信封/错误失败，不得返回假成功；Mock 与固定回答夹具不得写成真实 Harness 证据；跳过的测试不算通过。
5. **每角色唯一主指针**：交接激活是事务内比较并交换；旧实例无正式发布权。
6. **接收时绑定**：请求在接收事务内固定目标代次与知识快照，之后不自动迁移。
7. **主会话不被注入**：请求结果走收件箱归并，不注入用户主会话。
8. **版本固定**：依赖版本精确固定并保留锁文件；改动工具链先更新 `docs/toolchain.md`。

## 开发流程

一次只执行一个阶段（P0–P6，见 `prompts/`）；阶段完成后写 `docs/phase-reports/Pn-development.md`（状态"待独立验收"），由独立验收 Agent 按 `prompts/REVIEW.md` 验收后才能进入下一阶段。验证必须真实运行并保留证据（命令与结果），测试要覆盖状态与边界，不写逐字复述实现的测试。
