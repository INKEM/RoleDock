# P4 当前工作区复验（2026-10-13）

本轮结论：**REWORK**。基线为 `a083874e60e7a40d88a18e075b699b1fb818b0e1` + 当前 P5 未提交实现；现有 279 项测试全通过，但专项反例改变了受影响阶段的结论。

返工／缺口：R02/R03、R07、R10–R14（策略、回执、隔离、终态、预算、结果、恢复及重叠执行）。

逐项验收条件、问题优先级、触发方式、位置、影响、修复和复验方法统一见 [P0–P5 复验报告](P0-P5-revalidation.md)。本轮只改验收与计划材料，保留产品实现。新 GUI 要求另见 [桌面实施计划](../DESKTOP_GUI_PLAN.md)，不追溯作为旧阶段缺陷。

---

> 以下为此前验收报告原文，保留历史证据。其结论仅对应当时验收范围；当前继续开发门槛以上面的本轮结论为准。

# P4 独立验收报告：独立协作请求与继承者路由

- 阶段：P4（协作请求）
- 日期：2026-10-13
- 验收 Agent：ZCode（GLM，独立验收）
- 验收依据：`prompts/REVIEW.md`、`prompts/04-isolated-requests.md`、`prompts/COMMON.md`、`docs/DEVELOPMENT_PLAN.md`、`AGENTS.md`、`docs/phase-reports/P3-review.md`
- 被验收报告：`docs/phase-reports/P4-development.md`

## 结论：**PASS**

P4 全部六项验收条件均满足且有真实、可复现的证据；请求状态机、接收事务绑定、隔离执行、收件箱与采纳守卫实现正确；18 个 SDK 操作全部落地且无 NOT_IMPLEMENTED 残留；未发现需要返工的问题。

## 1. 验收基线

| 项 | 值 |
| --- | --- |
| HEAD | `a083874`（docs(p4): P4 development report） |
| 提交序列 | P3 验收基线 `1b8625c` + `36512ac`（P4 实现）+ `a083874`（报告），与开发报告 §1 一致 |
| 工作树 | 干净 |
| 范围核查 | P4 提交对 `P3-review.md` 的改动即验收 Agent 报告原样入库（结论 PASS 未动） |

## 2. 独立执行的验证与结果

| 验证 | 结果 |
| --- | --- |
| `npm ci` → 立即 `npm run check`（CI 等价序列） | **全绿：22 个测试文件、250 个测试全部通过，0 跳过** |
| `npm run check` 第 2、3 轮 | 全绿 ×2（250/250），与开发报告一致 |
| 业务角色名独立 grep（packages + adapters/mock 的 src 与 schemas） | 零命中 |
| 跳过/聚焦测试扫描 | 零命中 |
| 操作面收口 | `NOT_IMPLEMENTED` 抛出点为 **0**；测试断言 `IMPLEMENTED_OPERATIONS` 覆盖全部 18 个操作；CLI USAGE 无未实现路径 |
| CLI+SDK 端到端手工验证（全新临时工作空间） | 见 §3 |

## 3. 验收条件逐项核验（含手工复现）

### 条件 1：至少 10 个并发请求不混入消息、文件、结果和作用域；主会话历史无咨询消息 — ✅

测试逐项断言：10 个请求全部接收后再执行；10 个宿主会话各自 transcript **恰好只含自己的问题**（集合大小 10）；consultation 会话 `instance_id` 恒为 NULL；10 个独立 artifact 与收件箱条目；每请求临时目录全部回收；目标主会话行无任何请求分支记录。手工链路复核：创建→执行→artifact→收件箱→采纳全通，收件箱条目 unread→read 状态正确。bootstrap 只含分享快照与问题材料（宿主侧哈希校验），隔离会话不触目标主指针。

### 条件 2：与交接并发的请求符合接收顺序；排队旧请求保持快照；交接后新请求绑定新代次 — ✅

测试：gen1 时接收的请求在 owner 交接至 gen2 并发布新知识后执行，`binding_generation=1`、快照修订仍为 1；交接后的新请求 `binding_generation=2`。手工复核：新请求创建返回 `target_generation: 2`、快照条目数正确。接收事务内绑定（instance/generation/knowledge_revision/可分享快照/契约版本）后不迁移，与 ADR-0003 一致。

### 条件 3：同键同内容返回原请求，同键不同内容失败；重复执行不能重复登记正式结果 — ✅

CLI 手工实测：同键同内容 → `created:false` + 原 request_id；同键异内容 → `IDEMPOTENCY_CONFLICT`。正式结果仅在 running 态登记一次；取消后执行 → `INVALID_STATE_TRANSITION` 且状态保持 cancelled，不产生任何 artifact（测试断言）。迟到结果在完成登记前被状态检查拒绝（executor 代码顺序核实）。

### 条件 4：取消／超时后的产出不能完成请求或触发发布；创建不确定不重复有副作用操作 — ✅

- 采纳侧守卫：request state ≠ completed → `INVALID_STATE_TRANSITION`（"迟到或未完成结果不能触发发布"）；被取消请求无 artifact，伪造 id → `NOT_FOUND`。
- 到期为惰性检查（读路径与执行前），过期请求执行不消耗轮次并回收临时目录（测试断言）。
- 创建不确定复用 P3 机制：`execution_uncertain` 标记 + 按创建键 `request-<id>` 对账续接，无 lookup 能力时结构化失败且保留记录、不重复副作用（P3 已验收的机制在 executor 内同构实现并有测试）。

### 条件 5：跨身份读取、回复、取消和采纳请求均按权限拒绝 — ✅

测试权限矩阵：outsider 的 get/cancel/readArtifact、非发起者的 reply、跨角色的 adopt 采纳全部 `PERMISSION_DENIED`；CLI 手工实测：目标角色主会话（非发起者）取消发起者的请求 → `PERMISSION_DENIED`。回执前置同样以核心数据为准：无回执且无例外理由的新会话创建被 `VALIDATION_FAILED` 拒绝（CLI 手工复现，details 带回执数）。

### 条件 6：候选归并检查当前代次和版本，不给旧分支正式写权限 — ✅

- 采纳守卫：request 绑定代次 ≠ 当前 head 代次 → `REVISION_CONFLICT`（details 带双侧代次）；冻结契约版本不符 → `REVISION_CONFLICT`；**被拒采纳不留下任何 `request.result` 候选**（测试断言 open 候选数为 0）。
- 手工复现：gen1 绑定的结果在 owner 交接至 gen2 后采纳 → `REVISION_CONFLICT`；gen2 新请求执行后以其所有者身份采纳 → 修订 2、候选 `source='request.result'`/`state='adopted'`、收件箱转 read。采纳为纯数据库操作，不启动用户主会话新轮次（代码核实 + transcript 隔离断言）。

## 4. 专项与约束检查

- **任务 1–9 覆盖**：consultation 分支发起请求被拒（原型拒绝嵌套，`PERMISSION_DENIED`）；`ROLE_UNINITIALIZED` 有测试；预算（轮次/输出/期限）作为能力作用域边界，超限 → failed + `PERMISSION_DENIED` 不可绕过（测试：reply 重排后第二轮超限即 failed）；`needs_input` → awaiting_input → 仅发起者 reply → 重排队再执行一轮，发起者输入进入分支记录（测试断言）；outbox 事件登记与诊断查询面（`listRequests`/`listInboxEntries`）存在。
- **迁移 004**：`requests`/`request_artifacts`/`request_inbox` 表与 candidate_updates source CHECK 扩展（`request.result`）；既有迁移防护继续生效。
- **P0 硬约束延续**：核心与 Mock 无业务角色；声明≠授权未回退（预算=作用域、采纳=所有者显式、发布四重校验不变）；无跳过测试；Mock 未被写成真实宿主证据。
- **规范同步**：§3 细化（取消协商、惰性到期、预算边界、输入等待、回收、采纳守卫）与实现一致；`sdk-operations.md` requests/artifacts 语义更新。

## 5. 问题清单

无返工项。非阻塞观察项：

| 编号 | 优先级 | 说明 |
| --- | --- | --- |
| O-1 | P3 | no-business-roles 扫描名单范围（历阶段延续）。 |
| O-2 | P3 | 远程 CI 与托管位置待用户决策（P0 起延续）；本阶段 CI 等价序列首轮即全绿。 |
| O-5 | P2 | `adopt_artifact_id` 与收件箱列表目前仅 SDK/诊断面可达：CLI `documents publish` 只暴露 `candidate_id` 位置参数，收件箱无 CLI 入口。开发报告"18 个操作全部可用"为操作级陈述、属实，但 P5 的 CLI 演示若走"收件箱读取→显式采纳"链路需先补 CLI 旗标/子命令。 |
| O-6 | P3 | `budget.max_output_bytes` 当前度量的是请求材料（question）字节数而非宿主产出规模——真实产出与 token 用量一样以宿主报告为准（P5）。执行机制在位且不可绕过，度量目标为 Mock 时代的近似，建议 P5 接入真实宿主报告时补齐。 |
| O-7 | P3 | `requests/executor.ts` 中 `ExecutionResult` 接口重复声明两次（TS 接口合并，行为无害），下次触碰该文件时可顺手清理。 |
| O-8 | P3 | 真实宿主验证仍缺（P5 范围，沿用声明）：请求执行仍以 Mock 证明状态机制；模型 token 计量未模拟。 |

## 6. 下一步

1. **P4 通过**，按流程可进入 P5（Harness 与演示）。P5 可直接使用：适配器端口与请求执行引擎（真实宿主只需替换注入的 adapter）、全部状态机、回执与收件箱、CLI 全操作面、三层验证模型——开发报告 §6 交接清单与实际代码相符。
2. O-5 建议随 P5 的 CLI 演示一并补齐（采纳与收件箱的 CLI 入口）；O-6 随真实宿主报告机制补齐。
3. 本验收流程不授予代码合并或远程发布权限。
