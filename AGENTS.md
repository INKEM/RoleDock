# AGENTS.md — RoleDock 仓库开发指令

RoleDock 是一个通用 Agent 角色协议与参考运行时：支持自定义角色、文档化知识、会话继承和跨 Harness 的独立协作。开发 Agent 在本仓库工作前，先读 `docs/DEVELOPMENT_PLAN.md`（蓝图）、`docs/toolchain.md`（环境基线）与最新阶段报告 `docs/phase-reports/`。

2026-10-14 产品方向与当前门槛：阅读 `docs/DESKTOP_GUI_PLAN.md`、ADR-0007 和 `docs/phase-reports/P0-P5-revalidation.md`。桌面 GUI 为管理入口，会话只接入外部 Harness；用户在受信会话授权角色后由 Agent 显式锚定。GUI和真实角色闭环尚未实现；P5-A锚定和共享服务已独立验收本地PASS，见`docs/phase-reports/P5-A-review.md`。用户已指定ZCode，P5-H受限诊断可运行且本地边界通过，真实闭环独立验收BLOCKED，见`docs/phase-reports/P5-H-review.md`；需补人类来源、材料确认、请求隔离和资源控制，不进入GUI。P5-R本地独立验收PASS，P1–P4 PASS，P5整体仍因G01 BLOCKED；18项操作已有代码不代表全部行为已验收。按P5-R→P5-A→P5-H→P6-G→P6-R子阶段执行，每次一个子阶段并独立验收。

2026-10-24 P5-H 收口计划（ADR-0011）：G01-Z01 真人来源改由受信入口确认关闭——真人授权入口预留为内部接口（owner 面 `authorizations.submitHumanEvent` + 工作空间事件存储），GUI 最小授权确认面（G-min）自 P6-G 提前为独立子阶段。P5-H 以增量续作，一次一个并独立验收：B0 契约预留→B1 会话身份验证→B2 真人授权入口→B3 材料载入对账→G-min→B4 隔离实证与资源控制+全链收口；连接器工具契约见 `docs/zcode-connector-tools.md`，报告 `P5-H-bN-development.md`。能力声明仅在真实证据+验收后翻转。

2026-10-25 B0–B4/G-min 与 B5-0…B5-3 已独立验收 PASS（`P5-H-b1…b4-review.md`、`P6-G-min-review.md`、`P5-H-b5-0…b5-3-review.md`），G01-Z01/Z02/Z04 证据完备。隔离由 RoleDock 自有执行边界强制（ADR-0012）：B5-1 bubblewrap 受管 spawn + 出口白名单，B5-2 逃逸矩阵全拦截（验收方独立重跑一致），B5-3 步骤 7–8 真实跑通，B5-4 八步全链复验 + 受管变体进入 conformance 套件 + 验收前置 N1/N2 完成；**四项隔离声明已随受管执行声明翻转（受管变体与 `zcode_sandbox_status` 验证绑定、失败关闭；非受管保持 restricted/false）**。G01-Z03 关闭与 P5-H 解除 BLOCKED 待 B5-4 独立验收裁定（`P5-H-b5-4-development.md`）。

2026-10-25 最新有效门槛（覆盖上述历史状态）：`P5-H-b5-4-review.md` 已独立验收 **PASS**，G01-Z03 关闭、P5-H 解除 BLOCKED、P5 整体通过。G-min 仅为最小确认入口；完整 GUI 按新 `docs/DESKTOP_GUI_PLAN.md` 的 **P6-G0→G1→G2→G3→G4→G5→G6→G7→P6-R** 执行，每次一个子阶段并独立验收。原 ZCode 桌面会话与浏览器点击的产品证据在 G3/G7 补齐，不将既有测试连接器主会话当作完整桌面产品证据。

2026-10-27 P6-G 进度：G0–G2 已独立验收 PASS（`P6-G0/G1/G2-final-review.md`）。P6-G3 开发完成（`P6-G3-development.md`）：真实 ZCode 桌面原会话经 GUI 发现/登记→受信桥自动 recordHuman→原会话 Agent 显式 `sessions.anchor`→真实材料载入→active binding（generation 1）全链真机证据在 `phase-reports/evidence/2026-10-27-p6-g3/`；ADR-0014（原会话受信接入与凭据交接）与 desktop-gui-contract §9 定档；G-min 随机 event_ref 缺陷已修复为内容寻址幂等。

2026-10-28 P6-G 进度(覆盖上行状态):**G3、G4 均已独立验收 PASS**(`P6-G3-review.md`、`P6-G4-review.md`;G4 真机补充证据裁定为"材料待采",按 `evidence/2026-10-27-p6-g4/STEPS.md` 随 G5 跟进)。**P6-G5 实施中**:实施计划已留档(`P6-G5-plan.md`,用户预授权免审批,含"不实施 proposals.submit、编辑器本地草稿+导入流程提交候选"的裁定);G5 交付 owner 知识只读视图(文档目录/正文/修订/候选 + checkpoint 摘要/详情)与 #/knowledge 知识页。**P6-G5 开发完成待独立验收**(`P6-G5-development.md`):owner 知识只读视图 6 操作(目录/按需正文按 §3.2 矩阵/修订/候选/ checkpoint 摘要与详情)已实现并注册 Schema(契约 v8);#/knowledge 知识页(阅读、两版比较、候选基线冲突显示、本地草稿、导出导入——导入只建候选);`proposals.submit` 按计划裁定本轮未实施。`npm run check` 543/543、shell E2E 14/14(含 g5 全链),自动化证据在 `phase-reports/evidence/2026-10-28-p6-g5/`。**P6-G6 开发完成待独立验收**(`P6-G6-development.md`):owner 请求视图 5 操作(列表/详情/产物/回收/§6 管理取消——独立审计+幂等键)已实现并注册 Schema(契约 v9);迁移 9 增 `cleanup_error_json`;SDK 新操作 `inbox.list`(MCP `inbox_list`);#/inbox 请求收件箱页(unknown 用量、终态拒绝、回收分列、采纳指引)。`npm run check` 553/553、shell E2E 15/15,自动化证据在 `phase-reports/evidence/2026-10-28-p6-g6/`。G6 之后 G7(`prompts/06G7-release-validation.md`)同样先计划留档后实施。

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
- `adapters/` — `mock/`（内存宿主，P3）、`process-bridge/`（真实 fixture-host 子进程桥接，P5，`@roledock/adapter-process-bridge`），与 `zcode/` 复用契约套件 `tests/conformance/adapter-suite.ts`；`zcode/`（P5-H 已独立验收收口；受管变体经运行时验证后 full、非受管 restricted，见 B5-4 报告；真实桌面原会话产品接入留 P6-G3）。原 `harness-reference/` 目录设想由实际 zcode 参考接入承接，不额外建立重复空壳包。
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
