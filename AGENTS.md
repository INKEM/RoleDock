# AGENTS.md — RoleDock 仓库开发指令

RoleDock 是一个通用 Agent 角色协议与参考运行时：支持自定义角色、文档化知识、会话继承和跨 Harness 的独立协作。开发 Agent 在本仓库工作前，先读 `docs/DEVELOPMENT_PLAN.md`（蓝图）、`docs/toolchain.md`（环境基线）与最新阶段报告 `docs/phase-reports/`。

2026-10-14 产品方向与当前门槛：阅读 `docs/DESKTOP_GUI_PLAN.md`、ADR-0007 和 `docs/phase-reports/P0-P5-revalidation.md`。桌面 GUI 为管理入口，会话只接入外部 Harness；用户在受信会话授权角色后由 Agent 显式锚定。GUI和真实角色闭环尚未实现；P5-A锚定和共享服务已独立验收本地PASS，见`docs/phase-reports/P5-A-review.md`。用户已指定ZCode，P5-H受限诊断可运行且本地边界通过，真实闭环独立验收BLOCKED，见`docs/phase-reports/P5-H-review.md`；需补人类来源、材料确认、请求隔离和资源控制，不进入GUI。P5-R本地独立验收PASS，P1–P4 PASS，P5整体仍因G01 BLOCKED；18项操作已有代码不代表全部行为已验收。按P5-R→P5-A→P5-H→P6-G→P6-R子阶段执行，每次一个子阶段并独立验收。

2026-10-24 P5-H 收口计划（ADR-0011）：G01-Z01 真人来源改由受信入口确认关闭——真人授权入口预留为内部接口（owner 面 `authorizations.submitHumanEvent` + 工作空间事件存储），GUI 最小授权确认面（G-min）自 P6-G 提前为独立子阶段。P5-H 以增量续作，一次一个并独立验收：B0 契约预留→B1 会话身份验证→B2 真人授权入口→B3 材料载入对账→G-min→B4 隔离实证与资源控制+全链收口；连接器工具契约见 `docs/zcode-connector-tools.md`，报告 `P5-H-bN-development.md`。能力声明仅在真实证据+验收后翻转。

2026-10-25 B0–B4/G-min 与 B5-0…B5-3 已独立验收 PASS（`P5-H-b1…b4-review.md`、`P6-G-min-review.md`、`P5-H-b5-0…b5-3-review.md`），G01-Z01/Z02/Z04 证据完备。隔离由 RoleDock 自有执行边界强制（ADR-0012）：B5-1 bubblewrap 受管 spawn + 出口白名单，B5-2 逃逸矩阵全拦截（验收方独立重跑一致），B5-3 步骤 7–8 真实跑通，B5-4 八步全链复验 + 受管变体进入 conformance 套件 + 验收前置 N1/N2 完成；**四项隔离声明已随受管执行声明翻转（受管变体与 `zcode_sandbox_status` 验证绑定、失败关闭；非受管保持 restricted/false）**。G01-Z03 关闭与 P5-H 解除 BLOCKED 待 B5-4 独立验收裁定（`P5-H-b5-4-development.md`）。

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
- `packages/core` — 协调器与状态层。P4 已实现全部 18 个 SDK 操作：角色包加载/安装/查询、能力策略与 `WorkspaceAdmin`、版本文档（发布/读取/候选/回执/可见性）、CheckpointBuilder、knowledge.export/import、sessions.open/resume 与交接、requests.create/get/reply/cancel（接收绑定、预算、独立 consultation 分支、收件箱、迟到拒收）与 artifacts.read（旧分支无正式写权限）。适配器经 `Coordinator.open({ adapter })` 注入；`@roledock/core/testing` 是**仅测试夹具入口**，不是公开权限面。
- `packages/service` / `packages/mcp` — P5-A 共享单协调器 Unix socket 服务与受信会话 MCP stdio 客户端（Linux 本地独立验收 PASS）；所有者、受信宿主、普通会话三种连接面独立，Agent 无授权签发/管理员工具。
- `packages/desktop` — G-min 最小授权确认面（ADR-0011）：受信 owner 进程（127.0.0.1）+ 本地确认页（entry=gui-confirm），渲染层零凭据；真实锚定全链证据见 `phase-reports/evidence/2026-10-24-p5-h-gmin/`；完整五页面与桌面容器属 P6-G。
- `packages/cli` — `roledock` 命令行；默认人类可读，`--json` 输出机器信封；退出码 0 成功 / 1 运行错误 / 2 用法错误。全部 18 个操作已接通（documents/requests/artifacts 需 `--session`）；`--adapter mock|bridge`（默认 mock）选择宿主适配器；`--adopt-artifact` 显式采纳请求结果；`admin inbox/events` 为所有者诊断面。
- `adapters/` — `mock/`（内存宿主，P3）、`process-bridge/`（真实 fixture-host 子进程桥接，P5，`@roledock/adapter-process-bridge`），两者通过同一契约套件 `tests/conformance/adapter-suite.ts`；`zcode/`（P5-H 用户指定宿主的受限诊断接入，真实模型探针可运行，完整角色闭环仍 BLOCKED，见 P5-H 报告）。`harness-reference/` 完整接入未交付；不放置不可运行的空壳包。
- `examples/` — `demo-team`/`custom-role` 角色包与可重跑端到端演示 `examples/demo.mjs`（蓝图 7 步，机器日志 JSONL）。
- `docs/spec/` — 规范（对象与状态机、身份与权限、SDK 操作、适配契约）；`docs/adapter-guide.md`（适配实现指南）、`docs/quickstart.md`（CLI 快速上手）。
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
