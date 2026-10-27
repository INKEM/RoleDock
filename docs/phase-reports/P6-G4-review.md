# P6-G4 独立验收报告：会话观察、撤销与恢复

日期：2026-10-28。结论：**PASS**（含一项"材料待采"跟进项，见 §6——真机补充证据不构成本阶段阻塞，随 G5 补采）。

依据：AGENTS.md（硬性约束）、prompts/REVIEW.md、prompts/COMMON.md、prompts/06G4-session-observability.md、[P6-G4-development.md](P6-G4-development.md)（开发声明仅作线索，不作结论）、[desktop-gui-contract.md v7 §2.1/2.3/3/4/5](../spec/desktop-gui-contract.md)、[DESKTOP_GUI_PLAN.md §12](../DESKTOP_GUI_PLAN.md)、[ADR-0013](../adr/0013-desktop-orchestration-and-owner-views.md) 决策 3/7、前序 [P6-G3-review PASS](P6-G3-review.md)（观察 O1/O2/O3）。本轮止于验收：未修改产品实现、契约或开发报告，未做任何 commit/合并/发布。

## 1. 验收基线

- HEAD：`c52a45702ca67f55e4dccfd54251dceb5b779d12`（main，领先 origin/main 28 个提交；G0–G4 工作与阶段报告已由维护者提交，与 G3 验收时"未提交工作区"形态不同，属维护者正常收编）。
- 工作区：验收开始时仅 `docs/phase-reports/evidence/2026-10-27-p6-g3/real-session/user-data/DIPS-wal`（Chromium 缓存）一处改动——该文件在 G3 真机证据采集时入库，测试运行会翻动它；验收结束时已按惯例 `git checkout --` 还原，**验收后工作区干净**，未新增任何文件。
- 运行时：Node v22.23.2（`.nvmrc`，engine-strict 开启）。验收前后未改动基线。

## 2. 独立运行的验证命令与退出码

| 命令 | 独立结果 | 退出码 |
| --- | --- | --- |
| `nvm use` + `node --version` | v22.23.2 / npm 10.9.8 | 0 |
| `npm run check`（typecheck 全量 + vitest 全套，含 build） | **533/533 PASS（55 文件，379s）**，与开发报告声明一致；含 no-business-roles 71 项、G4 core 4 项、G4 service 3 项、shell-contract G4 词汇表、store 迁移计数、service-restart 真实进程集成 | **0** |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts`（仓库根，13 项） | **13/13 PASS（59.4s）**：G1×6 + G2×5 + G3×1 + **G4×1 全链**，无跳过 | **0** |
| `git status`（验收结束） | 干净（DIPS-wal 已还原） | 0 |

抽查证据目录 `docs/phase-reports/evidence/2026-10-27-p6-g4/`：`automated/gui-01-active-timeline.png`、`automated/gui-02-revoked-connection-split.png`（截图内容与开发报告 §6 声明逐项相符，见 §5）、`automated/shell-e2e-g4.log`（1/1 PASS 采集运行）、`STEPS.md`（真机步骤 1–8，含 O1 补拍 gui-03/gui-04 与凭据不外泄要求）、`collect-state.mjs`（四视图 owner RPC 投影导出，凭据不打印）、`submit-second-auth.mjs`。

## 3. 逐条验收条件核对（06G4 工作项 → 实际代码/行为/测试）

| 提示词工作项 | 核对结果 | 关键位置/证据 |
| --- | --- | --- |
| 1. owner 的 binding/attempt/load 分页视图（generation、前任、知识版本、授权来源、实际能力、载入确认） | **PASS**。三个视图共用 `listInput`（limit 1–200、不透明 `created_at|id` base64url cursor、`external_session_id` 过滤），全部带 `observed_at`；绑定视图含 generation、`predecessor_instance_id`、激活知识版本、来源授权（authorization_id/revoked_at/expires_at/source.kind/actor_id）、有效能力（会话 scope ∩ 工作空间策略 ∩ 授权能力，撤权态为空）、checkpoint 引用、`state_changed_at`；attempts 含四判据（host_session_id/load_key/content_hash/load_version）与错误消息层；loads 含 bundle_hash/load_version/`prepared_at`/`confirmed_at` | `packages/core/src/sessions/anchor.ts:182-305`、`packages/protocol/src/types.ts:551-665`、`schemas/session-bindings|anchor-attempts|anchor-loads.schema.json`（additionalProperties:false 全封闭）、`packages/service/src/index.ts:153-179`；core 测试断言 Schema 校验通过+过滤+两页 cursor 翻页，service 测试断言边界拒绝（limit 0/201、cursor 类型、BAD_ID） |
| 2. 连接状态与 active/superseded/released/revoked/expired/uncertain 区分；owner 撤销及影响预览；释放仍由原会话执行 | **PASS**。`state`（存储态）与 `effective_state`（显示层有效性）双字段，superseded 比较纯显示不写库（见 §4.1）；GUI 分列"连接"与"角色有效性"，断线提示"这是连接状态，不是授权撤销"；`revokePreview` 严格只读、撤销为独立显式写；shell 词汇表无 release（三个 sessions 方法 + 两个 authorizations 方法，契约测试+E2E 双重锁定）；uncertain 在进度链与撤销面均如实显示 | `anchor.ts:225-253,310-334`、`packages/desktop/src/shell/renderer/pages/confirm.ts:185-198,213-283,285-309`、`shell/shared/contract.ts:39-51`、`packages/desktop/test/shell-contract.test.ts:34-39`、g4.e2e.spec.ts 步骤 3/6/7 |
| 3. 有界轮询、观察时间和版本，防跨工作空间迟到响应；admin.events 维持 outbox 诊断 | **PASS**。活动页 2s setInterval、`document.hidden` 暂停、恢复可见立即刷新、离开页面停止并清理监听；所有分页响应带 `observed_at`；渲染层 `fresh()` 守卫按 workspace_id + observed_at 单调丢弃陈旧/跨工作空间响应（页面导航重建闭包，守卫恰命中真实的迟到响应窗口，符合 ADR-0013 决策 7）；`admin.events` 仍路由 outbox 元数据 SELECT，未升级 | `confirm.ts:199-210,272,311-334`、`packages/service/src/index.ts:180`、`packages/core/src/admin.ts`（未改动） |
| 4. 重启+重登记恢复绑定不加代次；takeover 保留旧已接收快照；release/revoke/expiry 按现有规则撤派生任务；显示 cleanup_pending 与执行不确定 | **PASS**。E2E 步骤 5 经 `workspace:restart` 真实停启服务进程（SIGTERM→宽限→SIGKILL→重新 spawn）后重登记，绑定 active、generation 1 不变，并由**全新 MCP stdio 客户端进程**（凭据文件刷新后）复核 `sessions.binding`；takeover 后旧实例 superseded+前任实例链由 core 测试实证；`invalidateBinding` 对派生请求置 failed+`cleanup_pending=1`、running 保留 `execution_uncertain`，按 authorization_id 精确撤权（第二授权不动）；"接收时绑定不迁移"由既有 P4 测试承载（requests.test.ts:248） | `packages/desktop/test/e2e-shell/g4.e2e.spec.ts:151-173`、`supervisor.ts:226-250`、core g4 测试 2/3、`packages/core/src/sessions/authorization.ts:17-60` |

**退出条件**（计划 §12）："GUI 能解释当前会话权限、继承来源、失败原因和下一恢复动作，无需查看数据库；撤权生效和外部回收确认分开；不做聊天历史查看器"——达成。E2E 断言观察块同时呈现：连接 running + 角色有效性、代次时间线（来源 human-event/owner、知识版本、能力）、失败尝试的错误码+消息、五种状态各自的"下一步"指引、观察时间；revoked 文案明确"撤销已在 RoleDock 生效；外部会话进程是否结束以宿主为准"；发现/观察均为元数据投影，无聊天正文通道。

## 4. 重点独立核查结果

1. **投影只读（含 superseded 显示层比较）**：`bindingView` 的 `effective_state` 是纯计算（`anchor.ts:232`），三个视图与 `revokePreview` 除共享的 `sweepAuthorizations` 到期清扫（与每次服务 tick 相同的维护语义，G3 已验收的同一先例）外零写入。core 测试以**直接读库前后对比**断言 listing 不改变 `session_bindings`/`anchor_attempts` 存储态；session 面 `binding()` 的写回语义（`anchor.ts:477-480`）按原行为保留，两者显式区分。head 易主而存储仍 active 的触发路径存在（SDK handoff 流更新 role_heads 但不动 session_bindings），显示比较正是为该错位服务。
2. **输出 DTO 白名单与逐字节保真**：四个新 DTO 只含公开标识、状态枚举、时间戳与能力名，无任何凭据形态字段；Schema `additionalProperties:false` 全封闭并在 service 传输边界对**输出**校验（失败即 INTERNAL，fail-closed）。core 测试断言 attempts 输出不含 `idempotency_key`/`input_hash`；`authorization_id`/`content_hash`/`host_session_id` 等公开标识经 shell `redact()`（SECRET_FIELD 名单不含它们）逐字节保真；自由文本仅具名字段（如 error.message）被 scrub。传输边界校验真实生效：service 测试实测输入侧拒绝，输出侧与 G2/G3 已验收的同一 fail-closed 模式。
3. **连接/有效性分列与陈旧守卫**：连接可用性来自 shell `workspace:status` 与登记态，角色有效性来自绑定 `effective_state`，UI 两处独立字段渲染（截图 gui-01/gui-02 可见并列展示）；revoked≠断线≠外部进程结束三者在文案与数据上均分离。轮询为有界 2s、隐藏即停。
4. **撤销面**：先预览后撤销（预览渲染确认按钮，E2E 断言预览后绑定仍 active）；无 owner release（词汇表测试+shell E2E+IPC 无 handler+服务 owner 面无此操作四重确认）；revoke 事务内 `COALESCE` 保已有 revoked_at、按 authorization_id 精确失效绑定；双授权场景 E2E 实证撤销其一后另一条 8h 授权仍可独立预览、`authorizations.get` 剩 1 条且不含被撤销者；GUI 确认面对存活授权拒绝二次确认的 G3 守卫保留（`gmin/confirm.ts:34`），并存授权经 owner 面 `submitHumanEvent` 产生。
5. **重启恢复测试真实性**：非 mock 断言——E2E 经 supervisor 真实 SIGTERM/respawn 服务进程，重登记后经 owner RPC 与全新 MCP 客户端进程双路复核 generation 不变；core 测试另证重登记幂等返回同一 ext。
6. **迁移 8**：仅两条 `ADD COLUMN`（`anchor_loads.confirmed_at`、`session_bindings.state_changed_at`），注释明示不回填；`store.test.ts:48` 断言迁移计数 8；旧行 NULL 且 GUI 显示"—"（载入记录行"已确认（确认时间未记录）"/时间线省略空状态变更），无伪造时间戳。
7. **测试真实性总评**：各层测试均有行为断言（只读前后对比、边界拒绝、三面互拒、状态机终态、清理失败夹具），无逐字复述实现；失败路径真实覆盖（load-incapable 适配器→ADAPTER_CAPABILITY_MISSING、closeSession 失败→cleanup_pending=1+uncertain=1）；E2E 用真实 Electron+真实服务+真实 MCP stdio 并如实标注零模型轮 mock 宿主，未把 mock 写成真实宿主证据。
8. **无业务角色**：独立 grep `packages/{core,protocol,service,mcp,desktop}/src` 零命中；conformance 71 项通过。G4 四操作名即 ADR-0013 决策 3 既有定档、轮询即决策 7，无架构/权限变化，不需新 ADR；无依赖变动（root package.json 仅前期桌面脚本，toolchain 未涉 G4 变更）。

## 5. 证据一致性核对

gui-01：连接 running（登记有效）与角色有效性"有权工作（active）"并列、代次时间线（实例、知识版本 r0、能力、来源 human-event/owner、创建+状态变更时间）、锚定尝试"已确认 v1"、载入记录"材料版本 1+确认时间"、观察时间与"有界轮询，页面隐藏时暂停"说明、撤销预览按钮在位。gui-02：同一块变为"连接：服务 running · 角色有效性：已撤销（revoked）——授权已失效"，时间线能力清空、状态变更时间更新，进度链显示第一条授权"已撤销 <时间>"而第二条 8h 授权（cli-console entry）未动且仍可单独预览；页尾日志"已撤销 …（授权撤销已在 RoleDock 生效…外部进程回收以宿主为准）"。两图与代码路径、E2E 断言、开发报告 §6/§7 声明一致。

## 6. 真机证据缺口裁定（不阻塞）

开发报告 §8 声明真机补充证据（gui-03…gui-07、`backend-state-real.json`）待用户配合采集，自动化证据覆盖同版本代码的相同代码路径。**裁定：不构成本阶段 BLOCKED 或 REWORK，作为"材料待采"跟进项随 G5（或最迟 G7 产品证据收口）补齐。**理由：

1. 06G4 提示词与计划 §12 均未把真机证据设为 G4 退出条件（与 G3 不同——G3 的退出条件明确要求"同一真实 ZCode 桌面原会话完成锚定"，故 G3 验收时真机链是必要条件）。G4 的四项退出条件全部可由自动化实证且已实证。
2. G4 验收对象是 owner 只读投影与撤销面，其行为不依赖模型轮；E2E 已用真实 shell+真实服务+真实 MCP 进程覆盖同一代码路径，唯一由 mock 顶替的是宿主会话本体，且开发报告如实分列、未冒充真机证据。
3. 缺口性质是证据冗余度（G3 O1 已定级"低"）：补拍步骤已在 `STEPS.md` 固化（步骤 1–8，含双授权、撤销面、重启恢复与后端状态导出），任何持有真实 ZCode 桌面会话的用户可独立执行；符合 REVIEW.md 对 BLOCKED 的定义边界——"当前实现无法补齐的外部输入"并不存在。
4. 后续约束：**G5 验收时应核查本目录是否已补 `FINDINGS.md` 与 gui-03…gui-07**；若届时仍未采集，应升级为 G5 验收观察项并说明原因。

## 7. 对 G3 验收观察的处理核对

- **O1（真机成功态截图）**：补拍步骤写入 STEPS.md 步骤 3/4（gui-03/gui-04），自动化侧 gui-01 覆盖同一画面同代码路径——处理方式成立，实物待采（并入 §6 裁定）。
- **O2（契约 §4 漏 bridgeStatus）**：已补记（desktop-gui-contract.md v7 §4，confirm 清单含 `bridgeStatus` 及其 G3 定档说明）。**落实**。
- **O3（E2E fixture 路径依赖 cwd）**：`g3.e2e.spec.ts:16` 与 `g4.e2e.spec.ts:19` 均以 `import.meta.dirname` 锚定 packageRoot/repoRoot，命令与 cwd 无关。**落实**。

## 8. 观察项（不影响本阶段 PASS，供后续参考）

- **O-A（低，显示细节）**：`revokePreview` 的 `bindings[].state` 是存储态、无 `effective_state`（`anchor.ts:315-317`）——head 已易主但存储仍 active 的绑定在预览中显示 active。撤销影响本身不受影响（撤销按 authorization_id 精确生效），且 GUI 时间线用的是 listBindings 的 effective_state；如后续统一显示语义，可在预览中复用同一显示比较，不需在本阶段返工。
- **O-B（低，边界澄清）**："先预览后撤销"是 UI 流纪律（预览渲染确认按钮）而非 IPC 层强制——渲染层直接调 `authorizations:revoke` 理论可行。revoke 本就是 owner 显式写（CLI 同样可达），不构成权限问题；如后续想强制，可在 IPC 层要求一次性 preview token，属可选增强。
- **O-C（记录）**：分页 UI 未做翻页控件（当前 limit=200 单页渲染，规模为登记会话数级）、`REVISION_CONFLICT` 真机复现仍未触发（G3 遗留沿用）——开发报告 §8 已如实披露，与契约 §2.3 定档一致。

## 9. 范围限制

- 未独立重跑真机步骤（需真实 ZCode 桌面会话与用户配合）；真机材料按 §6 裁定待采。
- 未单独重跑 `npm run desktop:e2e`（probe 回归）；IPC 边界随 13 项 shell E2E 回归。
- 未独立复跑证据采集运行（`automated/shell-e2e-g4.log` 为开发侧采集）；本轮以自身 13/13 E2E 运行与截图内容核对替代。

**P6-G4 PASS**。下一子阶段为 `prompts/06G5-knowledge-candidates.md`（计划 §13）；开始前建议先按 STEPS.md 采集真机补充证据并补 `FINDINGS.md`。本轮不自动开始开发、不提交、不发布；本报告不授予合并或发布权限。
