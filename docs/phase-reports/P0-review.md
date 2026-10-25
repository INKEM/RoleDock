# P0 当前工作区复验（2026-10-13）

本轮结论：**PASS**。基线为 `a083874e60e7a40d88a18e075b699b1fb818b0e1` + 当前 P5 未提交实现；现有 279 项测试全通过，但专项反例改变了受影响阶段的结论。

返工／缺口：无当前阶段返工项。PASS 仅针对 P0 契约与骨架，不代表后续运行时。

逐项验收条件、问题优先级、触发方式、位置、影响、修复和复验方法统一见 [P0–P5 复验报告](P0-P5-revalidation.md)。本轮只改验收与计划材料，保留产品实现。新 GUI 要求另见 [桌面实施计划](../DESKTOP_GUI_PLAN.md)，不追溯作为旧阶段缺陷。

---

> 以下为此前验收报告原文，保留历史证据。其结论仅对应当时验收范围；当前继续开发门槛以上面的本轮结论为准。

# P0 独立验收报告：通用契约与仓库骨架

- 阶段：P0（契约与骨架）
- 日期：2026-10-12
- 验收 Agent：ZCode（GLM，独立验收）
- 验收依据：`prompts/REVIEW.md`、`prompts/00-contract-and-scaffold.md`、`prompts/COMMON.md`、`docs/DEVELOPMENT_PLAN.md`、`AGENTS.md`
- 被验收报告：`docs/phase-reports/P0-development.md`

## 结论：**PASS**

P0 全部四项验收条件均已满足且有真实证据；未发现需要返工的问题。两项外部待确定项（远程托管位置、远程 CI 未运行）不阻塞本阶段，均已如实记录且属于阶段提示词明确允许的延后输入。

## 1. 验收基线

| 项 | 值 |
| --- | --- |
| HEAD | `2cad492`（fix(p0): narrow ci-workflow test type） |
| 提交序列 | `098f346 → bcdbcde → 1c1ed16 → c66f65a → 2cad492`，与开发报告 §1 一致 |
| 工作树 | 干净（`git status` 无未提交改动） |
| 环境 | Ubuntu（本机）、Node v22.23.2（与 `.nvmrc` 一致）、npm 10.9.8 |

验收在本基线上独立执行了全部验证；未沿用开发报告的运行结果作为结论依据。

## 2. 独立执行的验证与结果

| 验证 | 结果 |
| --- | --- |
| `npm ci` | 成功，0 vulnerabilities，锁文件精确安装 |
| `npm run check`（typecheck → build → vitest run） | **全绿：9 个测试文件、130 个测试全部通过，0 跳过** |
| CLI 手工冒烟 `--version` | 输出 `0.1.0-alpha.0`，退出码 0 |
| CLI `roles list`（人类模式） | stderr 错误行 `NOT_IMPLEMENTED`，退出码 1 |
| CLI `--json roles list` | stderr 合法 `ErrorEnvelope`（ok:false / code=NOT_IMPLEMENTED / details.spec 指向规范），退出码 1 |
| CLI 未知标志 `--definitely-not-a-flag` | 打印 USAGE，退出码 2 |
| `node:sqlite` 冒烟（独立复跑：STRICT 建表/预编译插入/查询/事务回滚） | 行为与 `docs/toolchain.md` 记录一致（含预期 ExperimentalWarning） |
| npm 名称独立复核 | `registry.npmjs.org/roledock` → 404（未占用），与报告声明一致 |
| 业务角色名独立 grep（`packages/*/src` + `packages/*/schemas`） | 零命中（grep 退出码 1） |
| 跳过/聚焦测试扫描（`.skip` / `.todo` / `.only` / `xit` / `fit`） | 零命中 |

## 3. 验收条件逐项核验

### 条件 1：Schema 能表示四个互不相同的角色，核心不存在业务角色枚举 — ✅

- `rolepack.schema.json` 的 `roleDefinition` 为自由 `id`（`^[a-z][a-z0-9-]{0,63}$`），无任何角色名/数量枚举；Schema 描述明示"核心不含角色名枚举"。
- `tests/fixtures/rolepacks/valid-four-roles.json` 使用四个非演示角色（archivist / cartographer / gardener / navigator），经 `validateRolePack` 校验通过，并覆盖全部三级可见性（project/role/private）与输出 Schema 字段——由 `tests/conformance/rolepacks.test.ts` 实测断言（4 个身份互异、可见性全集、能力名格式）。
- `tests/conformance/no-business-roles.test.ts` 递归扫描 `packages/{protocol,core,cli}/src` 全部 `.ts` 文件（≥6 文件门槛断言），逐文件断言不含 `builder|reviewer|explainer`；验收方独立 grep 复核为零命中。
- 语义层唯一性（同包内角色 ID、文档键、输出 Schema 键、能力名重复）在 `validateRolePack` 程序化补充，JSON Schema 无法表达的部分未被伪装为 Schema 能力；跨包 ID 冲突显式留待 P1 安装器（`ROLE_ALREADY_EXISTS`），边界划分有文档说明。

### 条件 2：继承冲突、旧实例发布、请求绑定时点、终态、创建不确定和可见性都有确定定义 — ✅

`docs/spec/objects-and-state-machines.md` 六项均有可执行的定义与错误码：

| 语义 | 定义位置 | 要点 |
| --- | --- | --- |
| 继承冲突 | §2 activate | 单事务比较并交换（generation + knowledge_revision 双校验），并发激活恰好一个成功，失败者 `GENERATION_CONFLICT`；准备期知识漂移必须重新准备 |
| 旧实例发布 | §2 retire + §4 | 旧代次发布一律 `INVALID_STATE_TRANSITION`；`sessions.resume ≠ 继承`，不加代次 |
| 请求绑定时点 | §3 + ADR-0003 | 接收事务内固定目标代次与知识快照；排队/运行中请求不自动迁移，新请求绑定新代次 |
| 终态 | §3 | `completed/failed/cancelled/expired` 四终态不可逆，复活转换返回 `INVALID_STATE_TRANSITION` |
| 创建不确定 | §3 + `identity-and-permissions.md` §4 | `execution_uncertain` 子状态；按创建键经 `lookupSessionByCreationKey` 对账，不盲目重试有副作用执行 |
| 可见性 | §5 | project/role/private 三级读取范围表，读取入口统一强制，越界返回 `PERMISSION_DENIED`；包内声明只是默认，策略可收紧 |

配套完整：§4 知识版本（发布同事务递增 `knowledge_revision` + `REVISION_CONFLICT`）、§6 幂等规则总表（5 操作 × 同键同/异内容）、outbox 衔接外部动作的统一规则。`docs/spec/sdk-operations.md` 对 18 个操作逐一给出输入/输出/身份/前置/错误/幂等/原子性（A=原子事务、O=outbox 衔接），错误码总表与 `ERROR_CODES`（13 码）一一对应，一致性由 conformance 测试保证。

### 条件 3：构建、类型检查及 Schema 测试真实通过；环境依赖记录完整 — ✅

- `npm run check` 在验收基线上全绿（130/130，0 跳过；含 src+tests 全量 noEmit 严格类型检查）。
- `docs/toolchain.md` 记录全部固定版本（Node 22.23.2 / TS 5.9.3 / vitest 5.0.4 / ajv 8.20.0 等）及核查依据、`engine-strict` 强制、SQLite 选型理由（`node:sqlite`，稳定性 1.1 已声明 + 回退预案）、冒烟证据与本机复现步骤。验收方独立复跑冒烟，结果一致。
- Schema 测试非逐字复述：`expectIllegal` 断言拒绝的同时校验 ajv keyword（如 `minimum`/`pattern`/`additionalProperties`/`required`），11 个非法夹具（路径穿越、绝对路径、大写 ID、重复角色 ID、坏枚举、非 semver、未知属性等）全部被实测拒绝；错误码注册表 ↔ 两个 Schema 内枚举集合相等有专项 conformance 测试。

### 条件 4：不把能力声明当实际权限，不声称已实现运行时继承或请求执行 — ✅

- `docs/spec/identity-and-permissions.md` §1–§2：身份来自受信会话绑定，客户端自报 `role_id` 不用于授权；`requested_capabilities` 是需求声明，发布权需所有权 + 当前主实例 + 代次有效 + `expected_revision` 四重校验。Schema 描述文本同义（"never grants execution or publish rights"）。
- `packages/core/src/coordinator.ts`：18 个方法全部抛 `NOT_IMPLEMENTED` `RoleDockError`；`packages/core/test/coordinator.test.ts` 从原型动态枚举操作面，逐一断言拒绝且错误码在注册表内，另有守卫测试防止未来实现"静默返回 undefined 伪装成功"。CLI 侧同样有 undefined 返回守卫。
- 无任何文件声称运行时继承、请求执行、真实 Harness 适配或权限策略执行已实现；`adapter-contract.md` §4 明文禁止把 Mock/固定回答夹具写成真实宿主证据。开发报告 §7 的"本阶段明确不声称"清单与代码事实一致。

## 4. 问题清单

无返工项（P0/P1 级问题为零）。以下为非阻塞观察项，供后续阶段参考，不构成本阶段缺陷：

| 编号 | 优先级 | 类型 | 说明 | 建议处置 |
| --- | --- | --- | --- | --- |
| O-1 | P3（低） | 加固建议 | `no-business-roles.test.ts` 的禁用名单目前仅含蓝图三个演示角色名；结构性保证实际来自 Schema 无枚举 + 代码扫描的组合。若未来出现新的硬编码角色名（不在名单内），扫描不会报警。 | P1+ 可扩展为"扫描字符串字面量枚举模式"或维护随示例包增长的名单；不阻塞 |
| O-2 | P3（低） | 记录确认 | 远程 CI（GitHub Actions）仅在本地以 yaml 解析测试过，无远程仓库可实际运行；`docs/toolchain.md` 已记录 GitHub 组织名被第三方占用的待确定项。 | 首次推送远程仓库时人工确认 CI 运行；发布位置由用户确定 |

## 5. 下一步

1. **P0 通过**，按 `prompts/README.md` 流程可进入 P1（角色与存储）。
2. 进入 P1 前无需返工；P1 实现须遵守本阶段固化的规范与 ADR（尤其 `ROLE_ALREADY_EXISTS`、路径越界/符号链接防御、受信会话绑定落库）。
3. 待确定项移交用户决策：远程托管组织/仓库位置与 npm scope 认领时机（见 `docs/toolchain.md` 命名核查记录）。

本验收流程不授予代码合并或远程发布权限。
