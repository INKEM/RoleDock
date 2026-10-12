# P1 独立验收报告：自定义角色与持久状态

- 阶段：P1（角色与存储）
- 日期：2026-10-12（首验）；2026-10-13（返工复验，结论更新为 PASS，见 §7）
- 验收 Agent：ZCode（GLM，独立验收）
- 验收依据：`prompts/REVIEW.md`、`prompts/01-roles-and-store.md`、`prompts/COMMON.md`、`docs/DEVELOPMENT_PLAN.md`、`AGENTS.md`、`docs/phase-reports/P0-review.md`
- 被验收报告：`docs/phase-reports/P1-development.md`、`docs/phase-reports/P1-rework.md`

## 结论（复验后）：**PASS**

首验结论为 REWORK（R-1、R-2 两项）。返工提交 `b4ceeae` 已按修复要求完成两项修复，复验（§7）全部通过；§3 的五项验收条件核验与 §5 的问题清单保留作首验记录，其通过结论在基线不变时沿用。

P1 的五项验收条件在行为层面全部有真实、可复现的证据支持；单协调器约束具备真实多进程验证，事务与错误语义实现正确。但验收发现两个可实现修复的问题：**(R-1)** 测试套件在本仓库 CI 的实际执行序列（`npm ci` → `npm run check`）下存在已复现的超时偶发，质量门禁不可靠；**(R-2)** 安装器幂等重装路径不恢复丢失的包内容，代码内注释对此做了与行为不符的声明。两处修复后复验即可通过，无需重做任何行为实现。

## 1. 验收基线

| 项 | 值 |
| --- | --- |
| HEAD | `01c33a7`（docs(p1): P1 development report） |
| 提交序列 | P0 基线 `098f346…2cad492`（未变动）+ `5df3075`（P1 实现）+ `01c33a7`（报告），与开发报告 §1 一致 |
| 工作树 | 干净 |
| P0 结论延续性 | P0 基线提交无改动，P0 通过结论无需重验；conformance 测试随新增源码从 11 扩至 22 个扫描用例并全部通过 |

## 2. 独立执行的验证与结果

| 验证 | 结果 |
| --- | --- |
| `npm ci` | 成功，0 vulnerabilities |
| `npm run check` 第 1 轮（`npm ci` 之后立即执行） | **失败：6 个测试在 vitest 默认 5000ms 超时**（161/167 通过；无断言失败，均为超时，见 R-1） |
| `npm test` / `npm run check` 第 2、3 轮 | 全绿：15 个测试文件、167 个测试全部通过，0 跳过 |
| `WorkspaceStore` 性能基准（本机） | `open` 256–598ms、单事务最高约 200ms（fsync 主导），慢测试基线 1.5–2.9s，对 5s 默认超时余量不足 3 倍（R-1 根因） |
| CLI 端到端（全新临时目录，每条命令独立进程 = 天然重启验证） | 安装 demo-team + custom-role → 4 角色；`roles list`/`resolve` 显示 `initialized:false`、generation 0、requested 与 granted 分列；跨进程重装 `reinstalled:true`；授权 `admin grant builder documents.read` 后新进程 `admin policy` 可见且持久 |
| CLI 冲突路径 | 跨包角色 ID 冲突 → `ROLE_ALREADY_EXISTS`（含 `details.role_ids`），同名同版本异内容 → `IDEMPOTENCY_CONFLICT`（含新旧哈希），退出码均为 1 |
| CLI 拒绝路径 | 路径穿越包 → `VALIDATION_FAILED` 退出码 1；未知角色 → `NOT_FOUND`；`documents publish` → `NOT_IMPLEMENTED` 退出码 1 |
| 内容丢失重装实验（安装后删除 `packs/<name>/<version>/`，重装同内容包） | 返回 `reinstalled: true`，**内容目录未恢复**（见 R-2） |
| 业务角色名独立 grep（`packages/*/src` + schemas + 迁移 SQL） | 零命中 |
| 跳过/聚焦测试扫描（`.skip`/`.todo`/`.only`/`xit`/`fit`） | 零命中 |

## 3. 验收条件逐项核验

### 条件 1：两个角色包可安装和查询，重启后状态仍在；冲突版本／角色 ID 返回结构化错误 — ✅

- CLI 与集成测试双路验证：两包（demo-team 三角色 + solo-archivist 单角色，身份与职责完全异构）安装成功，`roles list` 返回 4 角色含包名/版本/内容哈希；每次 CLI 调用都是新进程，后续查询即证明状态持久；`install.test.ts` 与 `examples-install.test.ts` 另有显式 close+reopen 断言（workspace_id 不变、角色仍在）。
- 冲突结构化错误经手工 CLI 实测：跨包 `ROLE_ALREADY_EXISTS`、同版本异内容 `IDEMPOTENCY_CONFLICT`，均带结构化 `details` 且退出码 1；未安装角色 `resolve` 返回 `NOT_FOUND`。

### 条件 2：权限需求声明不自动变成会话能力 — ✅

- `installRolePack` 仅写 role_packs/roles/role_heads，绝不写 `policy.grants`（`install.test.ts` 专项断言 `grants === {}`）；CLI 实测安装后 `granted_capabilities: []` 与 `requested_capabilities` 分列。
- `policy.evaluate` 是授权表上的纯函数，自报身份无授权即拒绝（`policy.test.ts`）；唯一授权入口是所有者面 `WorkspaceAdmin`（grant 幂等、revoke 未持有返回 `NOT_FOUND`、未知角色/畸形能力名拒绝），与会话面 `Coordinator` 分离，规范 `identity-and-permissions.md` §3 已固化该两入口模型。
- `TrustedIdentity` 形态已定但本期无任何 API 可铸造会话身份——"尚无会话可持有身份"本身就是诚实的 P1 保证。

### 条件 3：跨工作空间读写、包路径越界和错误迁移被拒绝 — ✅

- 跨工作空间：B 工作空间 resolve A 的角色 → `NOT_FOUND`；携带 A 的 workspace_id 调用 → `VALIDATION_FAILED`（`examples-install.test.ts` 断言两者）。
- 路径越界：loader 三类攻击全部拒绝——`..` 穿越、符号链接文件逃逸、符号链接目录逃逸（realpath 校验），外加"包内任何位置出现符号链接即拒绝"（含未引用的散落链接）与输出 Schema 远程 `$ref` 拒绝；穿越夹具经 CLI 实测被拒。
- 错误迁移：篡改 `schema_migrations` 校验和与写入未知迁移 id（模拟更高版本构建）均在 reopen 时以 `VALIDATION_FAILED` 拒绝（`store.test.ts`）。

### 条件 4：事务回滚不留下半安装角色包，状态存储不依赖某业务角色名称 — ✅

- 注入 roles 主键冲突使安装事务中途失败：role_packs 无新行、无 `.staging-*` 残留（`install.test.ts` 实测断言）；store 层事务回滚无残留行。
- 迁移 SQL、查询与存储层经独立 grep 与 no-business-roles conformance（22 用例逐文件扫描）双重确认无业务角色名；角色是包数据（examples 中的 builder/reviewer/explainer 仅为示例数据，符合 AGENTS.md 约束）。

### 条件 5：单协调器约束有真实进程或锁级验证 — ✅

- `workspace-lock.process.test.ts` 是真实多进程验证，且无时序依赖设计：子进程经真实 `WorkspaceStore` 持锁并等待 SIGKILL → **第三个进程**探测得到结构化 `WORKSPACE_LOCKED` 信封 → SIGKILL 后重新 open 成功（OS 释放锁、无陈锁）。另有同进程双开失败与恢复测试。实现层 `PRAGMA locking_mode = EXCLUSIVE` + `timeout: 0`（无忙等），错误映射诚实。
- 满足"不能只写在 README"的要求。

## 4. P0 硬约束延续检查

- 15 个未实现操作仍逐一抛 `NOT_IMPLEMENTED`（coordinator 测试动态枚举断言，含 spec 指针与错误码注册表校验）；CLI 未实现命令退出码 1 + 合法错误信封（信封经 protocol validator 在测试中校验）。
- 无业务角色进入核心（见条件 4）；`WORKSPACE_LOCKED` 新错误码在注册表、两个 Schema 枚举、规范 §8 四处一致（conformance 强制）。
- `npm run check` 中 typecheck（src+tests 全量严格）通过。

## 5. 问题清单（返工项）

### R-1（优先级 P1）：测试套件在 CI 等价负载下超时偶发，质量门禁不可靠

- **触发条件**：`npm ci` 紧接 `npm run check`（正是 `.github/workflows/ci.yml` 的执行序列），或任何使磁盘 fsync 变慢的并发负载下。
- **位置**：`vitest.config.ts`（无 `testTimeout` 配置，默认 5000ms）；受影响最重的为 `packages/core/test/store.test.ts`、`policy.test.ts`、`coordinator.test.ts`、`packages/cli/test/cli.test.ts`、`tests/integration/*`。
- **证据**：验收第 1 轮 `npm run check`（`npm ci` 后立即执行）6 个测试超时失败（161/167 通过，无断言失败）；随后 3 轮全绿。实测 `WorkspaceStore.open` 256–598ms、单事务最高约 200ms；EXCLUSIVE 锁 + 同步日志使每个工作空间操作多次 fsync，慢测试基线 1.5–2.9s，余量不足 3 倍；vitest 默认并行 worker 加剧 IO 争用。
- **影响**：远程 CI（ubuntu-latest，2 核）很可能复现同类超时，使"check 全绿"作为阶段证据的可信度受损；开发者本地也会偶发红测。开发报告"连续 4 轮全绿"为空闲机器上的真实记录，但未覆盖 CI 负载形态。
- **修复要求**：使套件在负载下确定性通过——为 SQLite/子进程密集的套件设置与其成本匹配的超时（如 `vitest.config.ts` 的 `testTimeout`，或逐文件超时），并可辅以集成测试降低文件级并行度；不得用删除断言或缩短验证来"修复"。
- **复验方法**：连续 ≥5 轮 `npm run check` 全绿，其中至少 1 轮在 `npm ci` 之后立即执行；如在 CI 可运行，附一次真实 CI 运行记录。

### R-2（优先级 P2）：同内容重装不恢复丢失的包内容，与代码内声明矛盾

- **触发条件**：安装在事务提交后、staging 目录原子改名前崩溃（或内容目录被外部删除），随后重装同一内容哈希的包。
- **位置**：`packages/core/src/roles/install.ts`——同哈希早退路径（约 L114–134）从不检查 `store_path` 内容是否存在；`install.ts` L161–162 注释声称"提交与提升之间崩溃留下的无内容行，由同内容重装路径（幂等）修复"，实测为假：返回 `reinstalled: true` 而内容目录缺失（验收已实测复现）。
- **影响**：数据库行声明已安装而内容不在，与"数据库状态为实时权威来源"（ADR-0004）的互斥假设（内容与行一致）出现隐性漂移。P1 内无操作读取包内容，暂无用户可见故障；P2（模板实例化）与 P3（instructions 载入）起将表现为远离根因的运行期缺文件错误。
- **修复要求**：重装路径在返回前校验已存储内容目录存在（最小实现：存在性校验，缺失时走一次 staging→提升修复）；或删除该注释并以规范明示"内容缺失需重装新版本"——二选一，修复须附回归测试（删除内容目录 → 重装 → 断言内容恢复且行为一致）。
- **复验方法**：运行该新增回归测试；重复验收方的"内容丢失重装"实验并得到 `content restored: true`。

### 非阻塞观察项

| 编号 | 优先级 | 说明 |
| --- | --- | --- |
| O-1 | P3 | no-business-roles 扫描名单仍仅含三个演示角色名（P0 验收 O-1 延续）；结构性保证来自 Schema 无枚举 + 逐文件扫描，当前可接受。 |
| O-2 | P3 | 远程 CI 与托管位置仍未确定（P0 验收 O-2 延续，待用户决策）；R-1 修复后首次推送 CI 的风险显著降低。 |

## 6. 下一步

1. ~~开发 Agent 按 R-1、R-2 返工~~（已完成，见 §7）。
2. ~~复验范围仅限 R-1、R-2 及其回归影响~~（已执行）。
3. R-1、R-2 均关闭后，P1 即满足进入 P2 的条件；本验收流程不授予代码合并或远程发布权限。

## 7. 返工复验（2026-10-13）

复验基线：`b4ceeae`（fix(p1): rework R-1 and R-2 from acceptance review），工作树干净。变更范围核对（`git diff 01c33a7..b4ceeae --stat`）：仅 `vitest.config.ts`、`packages/core/src/roles/install.ts`、`packages/core/test/install.test.ts` 与文档（开发报告更新、返工报告、本报告入库），无其他行为改动——与返工范围限定一致。入库的本报告首验文本与验收 Agent 原稿一致（结论 REWORK 未被改动）。

### R-1 复验：通过

- 修复内容核对：`testTimeout: 30000`、`hookTimeout: 30000`、`fileParallelism: false`（`vitest.config.ts`），未删除断言、未缩短验证，符合修复要求。
- 验收方独立执行复验序列：

| 轮次 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `npm ci` → 立即 `npm run check`（CI 等价序列） | **168/168 全绿** |
| 2–5 | 连续 `npm run check` | **168/168 全绿 ×4** |

满足"连续 ≥5 轮全绿且第 1 轮在 `npm ci` 后立即执行"的复验要求（首验时同一序列在第 1 轮即失败 6 项）。真实 CI 运行记录仍缺（无远程仓库，O-2 延续），不阻塞本阶段。

### R-2 复验：通过

- 修复内容核对：同哈希早退路径以 `rolepack.json` 为标记校验内容存在性，缺失时经 `copyToStaging`/`promoteStaging`（复用主路径原子提升逻辑，失败各自清理 staging）从已验证源包恢复，返回 `content_repaired: true`；不实注释已删除，替换为准确描述。
- 回归测试核对：新增"repairs lost pack content on identical reinstall (R-2 regression)"用例，断言恢复后文件树完整（`rolepack.json`/`roles`/`templates`）且角色行数不变；既有幂等测试补充 `content_repaired: false` 断言（含正常安装路径）。
- 验收方独立复跑"内容丢失重装"实验（走 `packages/core/dist` 构建产物，非测试代码）：

| 实验 | 结果 |
| --- | --- |
| 正常安装 | `reinstalled:false`，`content_repaired:false` |
| 删除内容目录后同内容重装 | `reinstalled:true`，`content_repaired:true`，**内容恢复：true**（首验为 false） |
| 内容完好时重装 | `reinstalled:true`，`content_repaired:false`（无误修复） |
| 修复后 staging 残留检查 | 无 `.staging-*` 残留 |

### 复验结论

R-1、R-2 均已关闭，复验通过。**P1 验收最终结论：PASS**，满足进入 P2 的条件。两项非阻塞观察项（O-1 扫描名单范围、O-2 远程 CI 与托管位置）延续，不阻塞后续阶段；O-2 仍待用户决策。本验收流程不授予代码合并或远程发布权限。
