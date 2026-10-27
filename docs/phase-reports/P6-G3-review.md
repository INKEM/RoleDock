# P6-G3 独立验收报告：原 ZCode 桌面会话授权与显式锚定

日期：2026-10-27。结论：**PASS**。

依据：AGENTS.md（硬性约束）、prompts/REVIEW.md、prompts/COMMON.md、prompts/06G3-session-authorization.md、[P6-G3-development.md](P6-G3-development.md)（开发声明仅作线索，不作结论）、[desktop-gui-contract.md §9 及 §2.2/2.3/4/5](../spec/desktop-gui-contract.md)、[ADR-0014](../adr/0014-original-session-trusted-access-and-credential-handoff.md)、前序 [P6-G2-final-review PASS](P6-G2-final-review.md)。本轮止于验收：未修改产品实现、契约或开发报告，未做任何 commit/合并/发布。

## 1. 验收基线

- HEAD：`d9743365256459a773a5319791cf3b7bb2e5fbe7` + 未提交工作区（99 个变更/新增文件；G0–G3 全部工作在未提交工作区，与 G0–G2 验收时形态一致，由维护者统一提交）。
- 运行时：Node v22.23.2（`.nvmrc`，engine-strict 开启）。验收前后未改动基线；验收过程只新增本报告。

## 2. 独立运行的验证命令与退出码

| 命令 | 独立结果 | 退出码 |
| --- | --- | --- |
| `nvm use` + `node --version` | v22.23.2 | 0 |
| `npm run check`（build + typecheck 全量 + vitest 全套） | **525/525 PASS（53 文件）**，与开发报告声明一致；含 no-business-roles 71 项、G3 服务集成 5 项、桌面 g3-confirm 4 项、适配器身份 3 项 | **0** |
| `npm run desktop:e2e:shell`（仓库根，文档化命令，含 shell 构建） | **12/12 PASS（G1×6+G2×5+G3×1）**，47.2s，无跳过 | **0** |
| `cd packages/desktop && npx playwright test --config=playwright.shell.config.ts`（首跑，非文档化调用） | 10 通过 / 2 失败——失败均因 spec 以 `resolve("examples/demo-team")` 按进程 cwd 解析 fixture，`packages/desktop` cwd 下路径错误；属调用方式问题非产品缺陷（见观察 O3），换文档化命令后全绿 | （记录用） |

## 3. 逐条验收条件核对（06G3 工作项 → 实际代码/行为/证据）

| 提示词工作项 | 核对结果 | 关键位置/证据 |
| --- | --- | --- |
| 1. 识别已打开原会话，受信主体登记，凭据只交工具启动器，模型自报 host ID 不定身份 | **PASS**。发现走 trusted 面 `externalSessions.discover`（输入强制空）→ adapter 可选端口 `listHostSessions` → 连接器 `zcode_list_sessions`（包装 `session/list`，元数据 only）；登记走 `externalSessions.register`（trusted principal 携带 subject，RPC 只收 `host_session_id`），`verifyExternalSession` 经 `zcode_verify_session`（session/resume 存在性 oracle）验证后才签发；会话凭据由主进程写 `<ws>/.roledock/mcp-session.env`（0600/O_NOFOLLOW/O_EXCL/原子重命名），`roledock-mcp` env 优先、缺省读文件并做 lstat（不跟随链接）/属主/0600 校验，不符即失败 | `packages/desktop/src/shell/main/event-bridge.ts:92-108`、`packages/desktop/src/shell/shared/credential-file.ts`、`packages/service/src/index.ts:105-110`、`adapters/zcode/src/index.ts:148-178`、`packages/mcp/src/bin.ts:17-39`；真机 ext-51b7252c 登记、backend-state.json `mcp_env_file.mode=384(0600)` 仅列键名 |
| 2. 主会话通道与受管通道能力/归属验证，非受管不继承 full | **PASS**。spike 实证持久化桌面会话（`session_*`，存储级枚举、跨实例可 resume）与实例内存会话（`sess_*`，跨实例不可 resume、不落数据库）结构性可辨；连接器工具入参 `REFERENCED_SESSION_ID` 接受两类，`create` 输出仍严格 `sess_*`；受管 consultation 仍走 `createSession` 沙箱路径；非受管产品启动 `runtime.level=restricted` 如实显示；适配器能力声明未翻转（external 四项既有声明，discovery 是运行时工具门控的可选端口，非新声明） | `spike-discovery/FINDINGS.md`、`adapters/zcode/src/reference-connector.ts:39,522,549`、`adapters/zcode/src/index.ts:67,108`、backend-state.json runtime 节 |
| 3. 复用 G-min 确认 + 能力差异/有效期/来源/稳定 action ID + 重复点击 | **PASS**。`confirmInput` 改内容寻址：`expires_at` 取整到下一小时桶，`event_ref = gui-<sha256(external_session_id, host_session_id, role_id, 排序后 capabilities, inherit, expires_at) 前 24 hex>`；entry/event_ref 仍在受信进程解析；服务端 `submitHumanEvent` 按 input_hash 幂等、改内容 `IDEMPOTENCY_CONFLICT`，`recordHuman` 按 source_key 幂等；GUI 能力对照显示"已授予/未授予——锚定后不生效" | `packages/desktop/src/gmin/confirm.ts:46-55`、`packages/core/src/sessions/anchor.ts:224-253,267-289`；单测同意图同 ref/能力序不敏感/改有效期=新意图/格式断言；真机 gui-01 双击两次"已确认"同一 `gui-96c7aa5a…` 仅一条事件，14:00 与 21:00 两条独立意图 |
| 4. 受信事件进度桥自动 recordHuman；Agent 显式 anchor；GUI 仅观察 | **PASS**。桥轮询 `authorizations.pendingEvents`（subject 来自受信 principal，输入强制空），逐条以**一次性最小特权凭据（ceiling=该事件能力）**调 `recordHuman`；服务端双重强制：subject 不匹配 `PERMISSION_DENIED`、事件能力超 ceiling `PERMISSION_DENIED`。GUI/桥无 anchor 通道：IPC 封闭清单 7 方法无 anchor；服务控制面 10 操作无 anchor；trusted/owner 主路径兜底 `PERMISSION_DENIED`；`sessions.anchor` 仅会话面（绑定到自身 external session）可达。GUI 文案"确认不是绑定、锚定由 Agent 显式调用"贯穿；桥失败入诊断不静默 | `event-bridge.ts:58-83`、`packages/service/src/index.ts:105-134,197`、`packages/core/src/sessions/anchor.ts:446-483`、`shell/shared/contract.ts:39`、`ipc.ts`；服务集成测试断言三面互拒；真机两事件均由桥推进（auth-d08daf22/auth-5d2ef4aa），attempt anchor-1bf2a72d active |
| 5. 真机全链证据；覆盖漂移/竞争/跨会话/失效/超范围/不确定恢复 | **PASS（含披露限制）**。真机同一原会话（`session_ef398d93…`，前后一致）完成 GUI 确认→事件→桥推进授权→原会话 Agent 经 MCP 调 `authorizations.get`/`sessions.anchor`→真实材料载入（load-e6517a0b，bundle_hash e3ac41e3，load_version 1，用户确认额度支出的真实模型轮）→active binding generation 1。跨会话/失效/超范围由服务与核心集成测试覆盖（三面隔离、IDEMPOTENCY_CONFLICT、ceiling、takeover 语义）；知识漂移/代次竞争真机未触发——如实披露（§7.1），语义由 P1–P5 核心测试与 B5-4 链承载，REVISION_CONFLICT/GENERATION_CONFLICT 路径在 `anchor.ts:339,393-405,410-411` 代码在位并有核心测试 | `real-session/`（STEPS.md、backend-state.json、gui-01/gui-02、shell-stdout.log）、`packages/service/test/g3-session-authorization.test.ts`、时间线核对见 §5 |

**退出条件**："同一真实 ZCode 桌面原会话完成锚定且角色工作前已载入；HTTP 直调、测试连接器新建主会话或仅数据库记录不能替代"——达成。原会话由用户在 ZCode 桌面打开（STEPS.md 流程），锚定经该会话内 MCP 工具发起（gui-02 实证该会话 MCP 连接与 Agent 工具调用在位；见观察 O1），材料载入轮落在该 host session 且经连接器 `zcode_lookup_load` 内容哈希+版本确认；非 HTTP 直调、非新建主会话；backend-state 经 owner RPC 产品投影采集（collect-state.mjs），非裸数据库。

## 4. 重点独立核查结果

1. **核心无业务角色**：`packages/{core,protocol,service,mcp,desktop}/src` 全文 grep `builder|reviewer|explainer` 零命中；conformance 71 项通过。builder 仅存在于 examples 角色包数据与测试 fixture。
2. **GUI/桥无 anchor 通道**：见上表第 4 项；E2E 另断言已绑定会话第二次 anchor 诚实拒绝（INVALID_STATE_TRANSITION）。
3. **event_ref 幂等**：双击/刷新同 ref（真机+单测）；改输入=新意图（单测+真机 14:00/21:00 分立）；小时桶边界内跨点重开得到同一 expires_at。
4. **凭据文件纪律**：0600/O_NOFOLLOW/O_EXCL/原子重命名（写侧），lstat 拒链接/属主/0600（读侧）；单测覆盖 0600 与原子替换，E2E 断言真文件 0600；单凭据文件语义（最后登记生效）与 ADR-0014 §9.2 一致，服务重启须重登记+完全重启 MCP 的限制如实披露（§7.3）。
5. **宿主身份验证**：verify 失败保留连接器层错误细节（`connector_error`）；connector 失败一律 uncertain、绝不转负；不同 subject 对已绑定 host 是确定性 false；workspace 回显校验在位。
6. **投影只读**：`listConfirmations`/`listPendingHumanEvents`/`discoverHostSessions` 均纯 SELECT + 共享的到期清扫（`sweepAuthorizations`，与每个服务 tick 相同的维护语义，不推进确认链）；discover 不创建、不附着、零模型轮。
7. **测试真实性**：抽查各层测试均有行为断言（同 authorization_id 幂等重放、三面互拒、limit 0/201 拒绝、双击一条事件、错误路径错误码），无逐字复述实现；E2E 用真实 Electron 窗口+真实服务+真实 MCP stdio 客户端，并明确标注零模型轮 mock 宿主，未把 mock 写成真实宿主证据；真机证据与 mock 证据在开发报告中分列。

## 5. 真机证据一致性核对

时间线自洽：登记 20:15 → GUI 确认 20:17/20:19（gui-01，双击幂等）→ 服务重启 20:26（缺陷 B 修复）→ 桥推进生成两授权 20:27 → 第二会话登记 20:32（takeover 确认未锚定，如实保留）→ anchor attempt 20:33:54 → active binding 20:34:06 → 采集 20:38。host ID `session_ef398d93…` 在 STEPS/gui-01/backend-state 三处一致；`runtime.level=restricted` 如实；双授权并存如实呈现；缺陷 A–D 均有对应回归测试。gui-01、FINDINGS.md、backend-state.json 与开发报告 §2/§5 声明逐项相符。

## 6. 观察项（不影响本阶段 PASS，均建议随 G4 处理）

- **O1（低，证据冗余度）**：gui-02 截图记录的是原会话 MCP 工具调用处于"授权为空"的早期状态（`authorizations:[]`、`binding:null`，桥推进前），成功的 `sessions.anchor` 调用结果与 GUI"active"进度链无真机截图；锚定成功目前由 backend-state（owner RPC 投影）+ 用户转述 + 载入确认（内容哈希+版本，且只有持 ext-51b7252c 会话凭据的连接可锚定该会话）支撑，不足以构成造假疑点但不满足 STEPS 第 6 步预设的截图。建议 G4 撤销/观察面验收时补：成功 anchor 调用结果与 active 链的真机截图各一张。
- **O2（低，文档一致性）**：`desktop-gui-contract.md` §4 的 confirm 清单未列入 `bridgeStatus`（代码清单 `shell/shared/contract.ts:39` 含之，开发报告已声明，§9.3 的诊断要求是其契约依据）。建议维护者做一行 §4 补录（属 G4 触及页面）。
- **O3（低，健壮性）**：shell E2E spec 以 `resolve("examples/demo-team")` 等按进程 cwd 解析仓库根相对路径，非文档化调用（`cd packages/desktop && npx playwright test`）会因路径解析失败 2 项。建议改为按 `import.meta.dirname` 解析或包根锚定，使命令与 cwd 无关。

## 7. 范围限制

- 未独立重跑真机全链（不重复消耗模型额度）；真机结论基于证据目录与代码路径交叉核验。
- 未重跑 `npm run desktop:e2e`（probe 回归）；G0 探针未单独重跑，IPC 边界随 12 项 shell E2E 回归。
- 知识漂移/代次竞争、受管 consultation 并发归属、服务重启凭据刷新体验未在真机复演（开发报告 §7 如实披露，前序验收承载）。
- 本轮 PASS 不授予合并/发布权限；全部工作仍在未提交工作区，是否 commit 由维护者决定。

**P6-G3 PASS**。下一子阶段为 `prompts/06G4-session-observability.md`（含 O1/O2 两项随做）；本轮不自动开始开发、不提交、不发布。
