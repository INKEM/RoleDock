# P6-G3 开发报告：原 ZCode 桌面会话授权与显式锚定

状态：**待独立验收**（开发方，2026-10-27）。按 [prompts/06G3-session-authorization.md](../../prompts/06G3-session-authorization.md) 执行；前置 P6-G2 独立验收 PASS。

## 1. 实际基线

- 提交基线：`d9743365256459a773a5319791cf3b7bb2e5fbe7`（P5 收口 docs 提交），全部 G0–G2 工作与本阶段交付均在**未提交工作区**（与前序子阶段一致，由维护者统一提交）。
- 本阶段起点：G2 final review PASS；无 G3 代码存在（G2 角色页明确"锚定留 G3"）。

## 2. 交付与验收条件对照

| 提示词工作项 | 交付 | 证据 |
| --- | --- | --- |
| 1. 识别用户已打开的原会话，受信主体登记，凭据只交工具启动器 | 受信桥 subject `desktop-event-bridge`；GUI 发现（`externalSessions.discover`→adapter `listHostSessions`→连接器 `zcode_list_sessions`）+ 粘贴引用后备；登记后服务返回的会话凭据由主进程写入 `<ws>/.roledock/mcp-session.env`（0600/O_NOFOLLOW/原子重命名）；`roledock-mcp` 支持 `ROLEDOCK_CREDENTIAL_FILE` | spike `spike-discovery/FINDINGS.md`；真机登记记录（§5）；`real-session/backend-state.json` |
| 2. 主会话通道与受管通道能力/归属验证 | spike 实证：持久化桌面会话（`session_*`，全局存储）与实例内存会话（`sess_*`）结构性可辨；受管 consultation 仍走 `createSession` 沙箱路径，无通道拆分需求；非受管产品启动 `workspace.runtimeStatus` 如实显示 `level=restricted`（backend-state.json runtime 节） | 同上；ADR-0014 决策 1 |
| 3. 复用 G-min 确认 + 能力差异/有效期/来源 + 稳定 action ID | `confirmInput` 改内容寻址 `event_ref`（sha256 截断 + 有效期小时桶）：真机截图显示同一意图双击产生同一 `gui-96c7aa5a…` 事件（日志两次"已确认"、进度链仅一条事件）；改变有效期=新意图（14:00 与 21:00 两条事件分立） | `real-session/gui-01-pending-chain-and-doubleclick-idempotent.png` |
| 4. 受信事件进度桥自动 recordHuman；Agent 显式 anchor；GUI 仅观察 | 桥轮询 `authorizations.pendingEvents`（主体绑定，输入强制空）→ 逐条幂等 `authorizations.recordHuman`（一次性最小特权凭据，ceiling=该事件能力）；GUI 进度链分阶段展示；GUI/桥无 anchor 通道 | 真机：两条事件均由桥推进（`auth-d08daf22`、`auth-5d2ef4aa`）；锚定由原会话 Agent 经 MCP 工具显式发起 |
| 5. 真机证据：GUI 点击→事件→授权→Agent 工具→载入→active binding；覆盖漂移/竞争/越权 | §5 真机全链；越权/跨会话/失效由服务集成测试覆盖（faces isolation、IDEMPOTENCY_CONFLICT、生成冲突为 P1–P5 既有语义，本轮演示项见 §7 未验证） | `real-session/` 全目录 |

**退出条件达成**：同一真实 ZCode 桌面原会话（`session_ef398d93c64146db2e7691b11fbaf813`，标题"测试会话回应请求"所在对话）完成锚定，角色工作前材料已载入（load confirmation `load-e6517a0b…` version 1，bundle_hash `e3ac41e3…`）。HTTP 直调未用于替代；测试连接器未新建主会话（受试会话由用户在 ZCode 桌面打开）。

## 3. 主要文件与公共接口变化

**协议**（契约先行为 G0 定档项，本阶段实现）：
- 新 Schema `authorization-confirmations` / `pending-human-events` / `host-session-discovery`；`service-control-operation` 增加 `authorizations.confirmations`（owner 读）、`authorizations.pendingEvents`（trusted 读，输入强制空）、`externalSessions.discover`（trusted 读）；类型镜像同步。
- core `ExternalSessionAuthority.listConfirmations/listPendingHumanEvents/discoverHostSessions`（只读投影）；port `HarnessAdapter.listHostSessions?`（`HostSessionInfo`）；mock/zcode 适配器实现。

**桌面 shell**：
- `shell/main/event-bridge.ts`（新，`EventProgressBridge`：轮询/推进/登记/发现，凭据不跨桥）；`shell/shared/credential-file.ts`（新，`writeMcpSessionEnvFile`）。
- IPC 清单扩展：`confirm.registerSession/discoverSessions/confirmations/bridgeStatus`；controller 对应方法；diagnostics 增加 bridge 状态（失败不静默）；确认页重写（发现/登记/能力对照/双击防护/进度链 2s 有界轮询/离开页面停止）。
- `gmin/confirm.ts`：`event_ref` 随机值 → 内容寻址（修复 G-min 重复授权缺陷）。
- `supervisor.ts`：服务环境从 `env:{}` 改为白名单 `{PATH(锁定运行时优先):/usr/bin:/bin, HOME, TMPDIR, LANG}`（§6 缺陷 B）。

**连接器/适配器/服务**：
- 连接器 `zcode_list_sessions` 工具（`session/list` 包装，零模型轮）+ `listSessions`；工具入参 `REFERENCED_SESSION_ID` 接受 `session_*` 与 `sess_*`（create 输出仍严格 `sess_*`）。
- 适配器 `verifyExternalSession`/`readHumanAuthorization` 身份守卫同步放宽；verify 失败保留连接器层错误细节；`listHostSessions`。
- 服务 `service/bin.ts`：mock 工作空间增加 `mock-desktop-original`（`desktop-event-bridge` 主体）种子 + `AttestingMockAdapter`（读已接线的事件源，镜像参考适配器 B2 行为；裸 Mock 语义不变）。
- `mcp/bin.ts`：env 凭据优先，缺省读 `ROLEDOCK_CREDENTIAL_FILE`（属主/0600 校验）。

**文档**：`docs/spec/desktop-gui-contract.md` §2.2/§2.3/§4/§5 + 新 §9；`docs/adr/0014-original-session-trusted-access-and-credential-handoff.md`（新）；`docs/zcode-connector-tools.md` §4.6。

## 4. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run check`（typecheck 全量 + vitest 全套） | 终轮 **525/525 PASS**（525 测试/53 文件）。过程记录：首轮门禁发现 `desktop.test.ts` 仍断言 G-min 旧 event_ref 格式（`gui-<时间戳>-<hex>`）——本轮已按契约 §5 新格式（内容寻址 `gui-<24hex>`）更新断言后全绿；新增 G3 测试 16 个（服务集成 5、桌面单元 4、适配器身份 3、shell E2E 1、其余为回归） |
| `npm run desktop:e2e:shell` | **12/12 PASS**（G1×6+G2×5+G3×1；一次满负载下 G1-R03 偶发失败，单跑与两轮复跑均过，判负载时序） |
| `npm run desktop:e2e`（probe 回归） | PASS |
| 真机 spike（零模型轮） | `spike-list.mjs`/`spike-resume.mjs`/`spike-listonly.mjs`，结论见 FINDINGS.md |
| 真机全链 | 见 §5；后端关联 `backend-state.json`，GUI 截图 ×2 |

## 5. 真实 ZCode 桌面原会话证据链（2026-10-27）

工作空间 `/home/inkem/Personal/RoleDock-g3-demo`（`ws-6f63f73c`，服务 adapter=zcode，非受管 restricted）。用户操作按 `real-session/STEPS.md`。

| 步骤 | 证据 |
| --- | --- |
| 发现 | GUI 列出该工作空间持久化桌面会话（含标题）；登记 `session_ef398d93…` → `ext-51b7252c-b4be-4586-9c05-fd97e73e4014`，subject=`desktop-event-bridge`，host ID 前后一致 |
| GUI 确认（双击幂等） | 截图 gui-01：确认后事件 `gui-96c7aa5a…`（entry=gui-confirm）仅一条；早前 1 小时期意图为独立事件 `gui-9a9e0827…`（改有效期=新意图，符合契约 §5） |
| 桥推进 | 两事件自动生成 `auth-d08daf22…`（1h）与 `auth-5d2ef4aa…`（8h），source.kind=human-event（backend-state.json confirmations 节） |
| Agent 显式锚定 | 用户在原会话让 Agent 调用 `authorizations.get`（返回两条有效授权）与 `sessions.anchor`（idempotency_key=`anchor-g3-real`，选 8h 授权）——会话内 MCP 工具调用截图 gui-02 与用户转述；attempt `anchor-1bf2a72d-2483-40ce-89a6-a5fb365e90e0` **active** |
| 真实材料载入 | load_key `load-e6517a0b-ae4c-4ab2-bcad-441f2e004238`，load_version 1，bundle_hash `e3ac41e3…`（真实模型轮，用户已确认额度支出） |
| active binding | generation **1**（实例 `inst-6f3e256b…`，内部会话 `sess-d70d62ee…`），state=active；builder `initialized=true, generation=1`；实际能力 `documents.read`（授权 4 项 ∩ 策略授予 1 项，窄化如实显示） |

## 6. 真机暴露并修复的产品缺陷（各配回归测试）

- **A. 会话 ID 格式三层一致**（B1 时代只认 `sess_*`）：连接器 `requireSessionId`、适配器 `verifyExternalSession`/`readHumanAuthorization` 全部接受 `session_<hex>` 持久化桌面会话；create 输出保持严格。真机粘贴引用与桥推进先后暴露两层；`adapters/zcode/test/g3-original-session.test.ts` 覆盖三条路径。
- **B. 服务最小环境破坏凭据 helper**：`env:{}` 使 helper 的 `#!/usr/bin/env node` 落到系统 Node v12.22.9（无法解析现代语法）→ 空输出 "malformed JSON"。修复为白名单 env 且锁定运行时 PATH 优先。发现错误现透出连接器层原因（`connector_error`）。
- **C. G-min 随机 event_ref**（继承缺陷）：内容寻址 + 小时桶，双击/刷新幂等（真机截图与单测覆盖）。
- **D. 适配器 verify 失败吞掉连接器细节**：不确定错误附加 `connector_error`。

## 7. 失败、跳过与未验证项

1. **知识漂移/代次竞争真机未触发**：锚定时 knowledge_revision 未变化，REVISION_CONFLICT 重试路径未在真机发生；语义由 P1–P5 核心测试与 B5-4 链覆盖，本轮不重复造景（不重复消耗模型额度，符合计划 §16）。
2. **双授权并存**：1h 与 8h 两条授权同时有效（两次不同意图，均未被撤销）。协议允许（授权与绑定分离），GUI/报告如实呈现；撤销属 G4 撤销面。
3. **服务重启后凭据刷新体验**：真机确认服务重启后须重新登记（幂等）重写凭据文件，且原会话 MCP 进程须**完全重启**才重新读文件（会话侧"重连"未重启 stdio 进程时持续 401 `Unknown connection credential`——用户实测）。v1 已知限制（ADR-0014 §9.2 单凭据文件语义），改善项（GUI"重新颁发凭据"入口、登记后提示重启 MCP）记入 G4 备选。
4. **受管 consultation 并发归属**：本轮产品启动为非受管（restricted 如实显示）；受管链归属由 B5-3/B5-4 既有验收承载，未在真机并发复演。
5. **第二会话 takeover 确认**（`ext-c3124951`/`session_3935575d…`）已确认未锚定——如实保留，接任语义属 G4 观察/撤销面验证。

## 8. 规范/ADR 影响

- ADR-0014（新）：发现/登记/凭据交接/事件桥/稳定 action ID 定档。
- desktop-gui-contract：G3 操作标记"已实现"，新增 §9（原会话受信接入）。
- zcode-connector-tools §4.6：`zcode_list_sessions` 契约与 spike 证据。
- 无能力声明翻转：原会话接入用既有 external 声明；受管隔离声明不变（backend-state.json runtime.level=restricted 如实）。
- toolchain 无依赖变更（无新 npm 包）。

## 9. 下一阶段可用输入与停止点

- 可用输入：可锚定的真实原会话与 active binding（GUI 可观察）、confirmations 进度链、owner 撤销入口（`authorizations.revoke`）与 G4 所需 binding/attempt/load 只读视图契约（§2.3 已定档未实现）。
- 停止点：本阶段完成即停，不进入 G4、不 commit、不远程发布；请独立验收 Agent 按 `prompts/REVIEW.md` 形成 `P6-G3-review.md`。
