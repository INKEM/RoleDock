# P4 开发报告：独立协作请求与继承者路由

- 阶段：P4（协作请求）
- 日期：2026-10-13
- 开发 Agent：ZCode（GLM）
- 前置：P3 已通过独立验收（`P3-review.md` 结论 PASS，基线 `1b8625c`）
- 状态：**待独立验收**

## 1. 实际基线

| 提交 | 内容 |
| --- | --- |
| `098f346`…`1b8625c` | P0–P3 已验收基线 |
| `36512ac` | P4 实现：请求服务、执行引擎、收件箱与采纳、迁移 004、CLI 收口、测试 |
| （本报告所在提交） | spec/AGENTS/README 更新 + P4 开发报告 |

工作树在提交后干净；无用户未提交改动需要保留。

## 2. 任务完成度与验收条件对照

P4 提示词 9 项任务：

1. ✅ **requests.create/get/reply/cancel**：前置材料 = 本会话真实读取回执（核心从回执表读取，输入不可伪造）**或**非空例外理由，皆无 → `VALIDATION_FAILED`；目标已安装且无主实例 → `ROLE_UNINITIALIZED`；consultation 分支发起 → `PERMISSION_DENIED`（原型拒绝嵌套）。
2. ✅ **接收事务绑定**：解析目标 RoleHead 固定 instance_id/generation/knowledge_revision/**可分享快照**（project/public 文档的确切修订+哈希 JSON）与**契约版本**；同事务登记 outbox 待执行事件（`request.execute`）。
3. ✅ **独立 consultation 会话**：每请求一个 adapter 宿主（creation_key=`request-<id>`），bootstrap 只含分享快照与问题材料（宿主校验哈希）；不触目标主指针、不注入其他请求——10 请求隔离测试逐 transcript 断言。
4. ✅ **独立资源与作用域**：每请求独立工作目录（question.md + tmp/），终态回收 tmp；默认只读；预算（轮次/输出/期限）是能力作用域边界——超限 → failed + `PERMISSION_DENIED`，不可绕过；模型 token 用量以宿主报告为准（Mock 不模拟，报告声明）。
5. ✅ **状态机与期限**：accepted/queued/running/awaiting_input + 4 终态；deadline 惰性到期（读路径与执行前检查）；`needs_input`（宿主报告，端口可选字段）→ awaiting_input，仅发起者 reply → 重排队再执行一轮。
6. ✅ **幂等与回收**：同键同内容返回原请求、异内容 `IDEMPOTENCY_CONFLICT`；创建不确定按创建键对账（`execution_uncertain` 记录、不重复副作用）；迟到完成（取消/过期/重复）→ `INVALID_STATE_TRANSITION` 拒收不登记；终态回收临时目录。
7. ✅ **结果与收件箱**：完成结果注册 artifact（内容寻址）+ 投递目标角色收件箱；所有者主实例经 `documents.publish({adopt_artifact_id})` 显式采纳——核心内联创建 `source='request.result'` 候选（绑定请求来源）并走标准 baseline/CAS；纯 DB 操作，不启动用户主会话新轮次。
8. ✅ **无嵌套/不可绕过**：见任务 1、4；预算失败与权限失败同码 `PERMISSION_DENIED` 语义（预算属能力作用域）。
9. ✅ **事件与诊断**：outbox 事件登记（request.execute/reply）与查询接口（`listRequests`/`listInboxEntries` 内部诊断面）；get/list 的身份与可见性过滤覆盖。

P4 验收条件逐项：

| 验收条件 | 证据 |
| --- | --- |
| 至少 10 个并发请求不混入消息、文件、结果和作用域，主会话历史无咨询消息 | requests.test.ts「10 并发隔离」：10 请求全部排队后逐个执行；10 个宿主会话 transcript 各只含自己的问题（集合大小 10）；10 个独立 artifact 与收件箱条目；consultation 会话 instance 恒为 NULL；tmp 全部回收；目标主会话行无任何请求分支记录 |
| 与交接并发的请求符合接收顺序，排队旧请求保持快照，交接后新请求绑定新代次 | 「交接并发」测试：gen1 接收的请求在 gen2 交接后执行仍用 binding_generation=1 + 快照修订 1；交接后新请求 binding_generation=2 |
| 同键同内容返回原请求，同键不同内容失败；重复执行不能重复登记正式结果 | 幂等测试（created:false + 原ID、IDEMPOTENCY_CONFLICT）；「迟到拒收」测试：取消后执行 → `INVALID_STATE_TRANSITION`、状态保持 cancelled |
| 取消／超时后的产出不能完成请求或触发发布；创建不确定不重复有副作用操作 | 取消后执行被拒（同上）；adopt 侧 state!=='completed' → `INVALID_STATE_TRANSITION`；不确定创建 → `ADAPTER_CAPABILITY_MISSING` + execution_uncertain，重试按创建键对账不新建（P3 机制复用，executeRequest 内同构处理） |
| 跨身份读取、回复、取消和采纳请求均按权限拒绝 | 「权限矩阵」测试：outsider 的 get/cancel/readArtifact、asker 对 owner 工件采纳 → 全部 `PERMISSION_DENIED`（另含 reply 跨身份用例于 awaiting 测试） |
| 候选归并检查当前代次和版本，不给旧分支正式写权限 | 采纳 stale-branch 守卫：绑定 generation ≠ 当前 head（或契约版本不同）→ `REVISION_CONFLICT`（details 双侧代次），不产生任何正式写候选；交接后采纳旧分支结果实测被拒 |

## 3. 主要文件与公共接口变化

- **`@roledock/core`**：Coordinator 实现最后 5 个操作（requests.create/get/reply/cancel、artifacts.read）——`IMPLEMENTED_OPERATIONS` 13 → **18，全部 SDK 操作落地**；`publishDocument` 新增 `adopt_artifact_id` 采纳入参；新模块 `requests/service.ts`（服务+权限+惰性到期）、`requests/executor.ts`（执行引擎）；迁移 004（`requests`/`request_artifacts`/`request_inbox` 表，candidate_updates source CHECK 扩展 `request.result`）。
- **端口/Mock**：`AdapterSessionResult.needs_input`（宿主报告输入需求）；Mock `needsInputAfterTurns`（精确轮次触发）。
- **`@roledock/cli`**：requests create/get/reply/cancel（question/reply 从文件参数）与 artifacts read 接通；USAGE 收口——**18 个操作全部可用，无 NOT_IMPLEMENTED 路径**（conformance 断言）。
- **规范更新**：`objects-and-state-machines.md` §3 细化（取消协商、惰性到期、预算边界、输入等待、资源回收、结果采纳与旧分支守卫）；`sdk-operations.md` requests/artifacts 交付语义；AGENTS/README 状态。

## 4. 实际运行的验证与证据

2026-10-13 本机（Ubuntu 22.04.5, Node v22.23.2）实际执行：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（src+tests 全量，含 adapters） |
| `npm test` / `npm run check` | **22 个测试文件、250 个测试全部通过，0 跳过**；连续 3 轮 check 全绿 |
| P4 新增测试 | 13 个（前置条件 4、隔离×10 一例含 60+ 断言、交接并发、awaiting/reply、预算、迟到拒收、过期惰性、权限矩阵、采纳守卫），另更新 6 处 P1–P3 时代断言（全操作落地后无 NOT_IMPLEMENTED 路径） |

开发过程中修复的问题：adopt 查询漏选 binding 列导致合法采纳被误判过期（补列修复）；嵌套检查顺序（先验会话种类再验实例绑定）；needs_input 语义定为"精确轮次匹配"（首轮等待、次轮完成，可测）；迁移 004 与三处历史断言随操作面收口更新。

## 5. 失败、跳过、未验证与外部阻塞项

- **无跳过的测试，无失败遗留。**
- **模型 token 计量未实现模拟**：预算以轮次/输出字节/期限落地，token 以宿主报告为准（规范已声明），真实宿主接入（P5）时由适配器上报。
- **真实宿主验证仍缺**（P5 范围，沿用声明）：本阶段请求执行仍以 Mock 证明状态机制。
- **明确不声称**：业务验收状态机、学术调度、递归请求、token 预算不进入核心；执行隔离不足的宿主仍按受限等级拒绝写入类任务（本阶段请求默认只读）。
- 沿用待确定项：远程 CI 与托管位置（O-2）；P2 验收 O-3（导入候选 proposed_by_session 合成标识）继续有效——P4 采纳路径的候选由所有者会话创建，proposed_by_session 为真实会话，不受 O-3 影响。

## 6. 下一阶段可用输入与尚未满足的退出条件

**P5 可直接使用**：适配器端口与请求执行引擎（真实宿主只需替换注入的 adapter）；sessions/handoffs/requests 的全部状态机；回执与收件箱（端到端演示材料）；CLI 全操作面；`docs/spec/adapter-contract.md` 三层验证模型（process-bridge 与真实 Harness 在 P5 落地）。

**P4 退出条件核对**：并发隔离及新旧代次路由测试通过 ✅（§2 对照）。

按流程，下一步把 `prompts/REVIEW.md` 交独立验收 Agent 验收 P4（基线以 `git log` 为准，HEAD 为本报告提交）；验收通过前不执行 P5。
