# P0 开发报告：通用契约与仓库骨架

- 阶段：P0（契约与骨架）
- 日期：2026-10-12
- 开发 Agent：ZCode（GLM）
- 状态：**待独立验收**（正式通过状态由独立验收流程给出，见 `docs/phase-reports/P0-review.md`，尚不存在）

## 1. 实际基线

仓库为全新本地 git 仓库（P0 执行 `git init`，分支 `main`，无远程）。提交序列：

| 提交 | 内容 |
| --- | --- |
| `098f346` | 基线：蓝图 `docs/DEVELOPMENT_PLAN.md` 与全部 `prompts/`（自 `development/` 提升至仓库根，文件内容未改动） |
| `bcdbcde` | 协议契约 + core/cli 骨架 + 全部测试 |
| `1c1ed16` | 规范、ADR、环境基线、CI、仓库顶层文件 |
| （本报告所在提交） | P0 开发报告 |

无用户未提交改动需要保留：工作目录在 P0 开始时仅含 `development/`（蓝图材料），已按蓝图布局提升至根级并纳入版本控制。

## 2. 交付与验收条件对照

P0 提示词验收条件逐项对照：

| 验收条件 | 交付 | 证据 |
| --- | --- | --- |
| Schema 能表示四个互不相同的角色，核心不存在业务角色枚举 | `rolepack.schema.json` 可表达任意角色；`tests/fixtures/rolepacks/valid-four-roles.json`（archivist/cartographer/gardener/navigator 四个非演示角色）通过校验；`tests/conformance/no-business-roles.test.ts` 扫描 `packages/*/src` 确认无业务角色名 | `npm test` 中 4+8 个对应用例通过 |
| 继承冲突、旧实例发布、请求绑定时点、终态、创建不确定和可见性都有确定定义 | `docs/spec/objects-and-state-machines.md`（§2 交接状态机与 GENERATION_CONFLICT/重新准备规则、§3 请求状态机与终态不可逆/execution_uncertain、§4 知识版本、§5 可见性）；`docs/adr/0002`、`docs/adr/0003`；错误码注册表（`GENERATION_CONFLICT`、`INVALID_STATE_TRANSITION` 等）入 Schema 枚举与 `ERROR_CODES` | 规范 4 篇 + ADR 6 篇；错误码一致性测试 |
| 构建、类型检查及 Schema 测试真实通过；环境依赖记录完整 | `npm run check` 全绿（130 测试）；`docs/toolchain.md` 记录固定版本、核查命令与 node:sqlite 冒烟证据 | 本文 §4 验证记录 |
| 不把角色包能力声明当实际权限，不声称已实现运行时继承或请求执行 | 规范 `identity-and-permissions.md` §2 明确"需求声明≠授权"；Schema 描述文本同义；core 全部 18 个 SDK 方法测试断言抛 `NOT_IMPLEMENTED`；CLI 未实现命令退出码 1 + 错误信封 | `packages/core/test`、`packages/cli/test`、`tests/integration` |

P0 任务清单完成度：

1. ✅ 仓库/改动/工具链检查与命名核查（npm `roledock` 未占用；GitHub 组织名被第三方占用 → 待确定项，见 §6）
2. ✅ 工具链固定并验证（Node 22.23.2 / npm 10.9.8 / TS 5.9.3 / vitest 5.0.4 / ajv 8.20.0 / ajv-formats 3.0.1 / SQLite=node:sqlite）
3. ✅ 三包工作区 protocol/core/cli；mcp 包与 adapters/examples 仅留目录约定，无空壳包
4. ✅ 8 个 JSON Schema + TS 类型镜像 + 错误码注册表（rolepack、role-head、document-revision、checkpoint、bootstrap-bundle、collaboration-request、输出/错误信封）
5. ✅ 规范 4 篇（状态机/权限/SDK 操作/适配契约）
6. ✅ SDK 操作契约：18 个操作的输入输出、身份来源、前置、错误码、幂等、原子性分类（A/O）
7. ✅ ADR 6 篇（单协调器、语义继承、接收时绑定、文档权威、声明式角色包、场景独立）
8. ✅ CI + 根命令 `build`/`typecheck`/`test`/`check`；未实现功能以 `NOT_IMPLEMENTED` 如实失败；Schema 合法/非法输入测试齐备

## 3. 主要文件与公共接口

**新增公共接口（全部为 P0 契约面）：**

- `@roledock/protocol`：`validate(schemaName, value)`、`validateRolePack(value)`（含 Schema 外语义唯一性校验）、`ERROR_CODES`（13 个错误码）、`RoleDockError`/`toErrorEnvelope`、全部契约 TS 类型、`PROTOCOL_VERSION="0.1"`；`exports: ./schemas/*` 暴露原始 Schema。
- `@roledock/core`：`Coordinator`（18 个 SDK 方法，全部 `NOT_IMPLEMENTED`）、`coordinatorOperations()`、`CoordinatorOptions`。
- `@roledock/cli`：`bin: roledock`（`dist/bin.js`）、`runCli(argv, io)`、退出码 0/1/2、`--json` 信封输出。

**关键文件：**

```text
packages/protocol/schemas/*.schema.json   8 个 Schema（draft 2020-12）
packages/protocol/src/{types,errors,error-codes,validate,index}.ts
packages/core/src/coordinator.ts
packages/cli/src/{cli,bin,index}.ts
docs/spec/{objects-and-state-machines,identity-and-permissions,sdk-operations,adapter-contract}.md
docs/adr/000{1..6}-*.md
docs/toolchain.md
tests/{conformance,integration,fixtures}
.github/workflows/ci.yml
AGENTS.md  README.md  LICENSE(Apache-2.0)  .nvmrc  .npmrc(engine-strict)
```

**技术基线决定**（详见 `docs/toolchain.md`）：SQLite 采用 Node 22 内置 `node:sqlite`（零原生依赖；官方稳定性 1.1 已声明；冒烟验证通过），如 P1 落库遇 API 变更再评估 better-sqlite3 回退。

## 4. 实际运行的验证与证据

2026-10-12 在本机（Ubuntu 22.04.5, Node v22.23.2）实际执行：

| 命令 | 结果 |
| --- | --- |
| `npm install` | 成功，0 vulnerabilities；`package-lock.json` 入库 |
| `npm run typecheck`（`tsc -b --force` + `tsc -p tsconfig.check.json`） | 通过（src+tests 全量严格检查） |
| `npm test`（build + vitest run） | **9 个测试文件、130 个测试全部通过，0 跳过** |
| `npm run check` | 通过（typecheck → test 串行门禁） |
| node:sqlite 冒烟（建表/插入/查询/事务回滚） | 通过，输出存 `docs/toolchain.md` |
| CI YAML | `tests/conformance/ci-workflow.test.ts` 用 yaml 2.9.1 实际解析并断言 job/steps/Node 版本固定（3 用例在 130 个之内） |
| CLI 手工冒烟 | `node packages/cli/dist/bin.js --version` → `0.1.0-alpha.0`；`--json roles list` → 退出码 1 + `NOT_IMPLEMENTED` 信封 |

测试构成：protocol Schema 合法/非法用例（含路径穿越、绝对路径、大小写 ID、坏枚举、非 semver、未知属性、四类语义唯一性）；四角色 conformance；非法 fixture 集（11 个）全部被拒；错误码注册表↔Schema 枚举一致性；无业务角色扫描；core 全操作 NOT_IMPLEMENTED（含错误码注册表校验）；CLI 进程内与子进程双层冒烟。

## 5. 失败、跳过、未验证与外部阻塞项

- **未验证：远程 CI**。GitHub Actions 配置已写并通过本地 YAML 解析测试，但无远程仓库，无法实际运行验证。首次推送时需确认。
- **外部阻塞（待确定项）：发布位置未配置**。npm 包名 `roledock`/`@roledock` 当前未占用（2026-10-12 核查）；GitHub `github.com/roledock` **组织名已被第三方空组织占用**。用户未指定托管位置，本轮按约仅本地开发、未创建任何远程仓库。发布前需用户确定组织/仓库与 registry 位置；npm 侧建议尽早认领 scope。
- **记录在案的风险**：`node:sqlite` 为 Node Stability 1.1（实验）；已用精确 Node 版本固定行为，风险与回退方案记录于 `docs/toolchain.md`。
- **无跳过的测试**；无失败遗留（开发过程中 typecheck/测试问题均已修复至全绿）。
- ajv-formats/ajv 为 CommonJS 包，在 NodeNext 下的类型导入需要显式收窄（代码内注释说明），不影响运行时。

## 6. 规范／ADR 说明

P0 即规范初始版本，无历史规范需要变更。6 篇 ADR 与 4 篇规范为后续阶段（P1–P5）的实现约束：例如 P1 的角色安装必须实现 `ROLE_ALREADY_EXISTS` 语义（ADR-0005），P3 的激活必须实现比较并交换与撤权（ADR-0002、规范 §2），P4 的接收绑定（ADR-0003）。两处 P0 内部的实现性修正：Schema 校验对"不可表达于 JSON Schema 的唯一性"（角色 ID、文档键等）在 `validateRolePack` 中程序化补充；`collaboration-request` 的 `execution_uncertain` 采用布尔子状态字段（跨字段约束由状态机规范约束，Schema 仅校验形态）。

## 7. 下一阶段可用输入与未满足的退出条件

**P1 可直接使用：** Schema/类型/错误码（`@roledock/protocol`）、Coordinator 操作面与失败契约、工具链基线与 SQLite 选型、AGENTS.md 硬性约束、规范与 ADR 的实现要求。

**P0 退出条件核对：** 状态语义确定（规范固化）✅；工具链自检通过 ✅。P1 尚需满足：角色包真实加载与安装（含路径越界/符号链接防御）、身份与 SQLite 状态层落地、权限策略接入——这些属 P1 交付，不在 P0 声称。

**本阶段明确不声称：** 运行时继承、请求执行、真实 Harness 适配、权限策略执行均未实现（全部 `NOT_IMPLEMENTED`）。

---

按 `prompts/README.md` 流程，下一步应将 `prompts/REVIEW.md` 交独立验收 Agent 验收 P0（基线以本报告 §1 提交序列为准）；验收通过前不执行 P1。
