# P5-H 增量 B2 独立验收：真人授权入口内部接口

日期：2026-10-24
验收方：独立验收 Agent；未修改产品实现、未发送模型任务
结论：**PASS**

## 1. 范围与基线

验收对象为 P5-H 收口计划第二增量 B2（ADR-0011 决策 1/2 的实现交付），开发报告 `P5-H-b2-development.md`。基线与 `P5-H-b1-review.md` §1 相同（同一未提交工作区；自 B4 门禁证据后无源码改动）。

## 2. 逐项核验

| 验收条件 | 实际行为与证据 | 判定 |
| --- | --- | --- |
| 事件存储迁移 | `store/migrations.ts` 迁移 7 实读：entry CHECK 约束、PK (workspace, external_session, event_ref)、读路径索引 (workspace, host_session_id, event_ref) 与适配器端口对齐；store.test.ts 迁移计数 6→7 已更新并在全量门禁通过。 | 满足 |
| `submitHumanEvent` 实现 | anchor.ts:135-164 实读：Schema 校验→已注册会话身份一致（host/subject 不符 `VALIDATION_FAILED`）→幂等哈希仅覆盖事件事实（entry/recorded_at 不参与，任何受信入口重放同一确认返回原记录，事实变更 `IDEMPOTENCY_CONFLICT`）。core B2 测试断言跨入口/跨时间重放返回原记录、事实变更拒绝。 | 满足 |
| 服务面 owner 专用 | `packages/service/src/index.ts` 实读：`submitHumanEvent`/`externalSessions.list` 仅 owner 面分发；trusted 面落入"cannot call owner or Agent operations"拒绝。service B2 测试实读断言 trusted 调用与伪造 token 均 `PERMISSION_DENIED`。 | 满足 |
| CLI 受信写入面 | `roledock admin submit-human-event`（9 参数严格校验，entry 固定 cli-console）；cli B2 测试断言写入 0、幂等重放 0、host 不符退出 1、多余参数退出 1。真实证据 `2-cli-write.log`：写入成功 + Step 3b 重放返回首次 `recorded_at`（first-write-wins 生效）。 | 满足 |
| 适配器读取口 | anchor.ts 构造时自动接线 `storeHumanAuthorizationSource`；`ZCodeAdapter.readHumanAuthorization` host/ref 本地校验、无 source 时 `NOT_IMPLEMENTED`；workspace/subject/天花板一致性由核心 recordHuman 执行（anchor.ts:123-124）。core/zcode 测试覆盖。 | 满足 |
| 声明翻转 | `current_session_identity: false→true`（B1 真实证据背书）：B2 `1-stage.log` 以**生产声明**经真实 register 注册真实会话并 resume 验证通过。`human_authorization_events` 保持 false：真实 recordHuman 证据中该声明为 fixture 翻转且输出与报告均如实标注（`3-record.log`），生产路径仍按门禁拒绝。 | 满足 |
| 真实四步链 | `evidence/2026-10-24-p5-h-b2/`：真实会话创建→owner CLI 写入（幂等）→recordHuman 全链产出 `auth-717d12c7…`（source human-event）→store-dump 迁移 1–7 全应用、恰一条事件、source_key 三元组正确。 | 满足 |

## 3. 独立验证

全量门禁实跑通过（除 `P5-H-b4-review.md` F1 环境性超时外，core B2 4 项、zcode B2 2 项、service B2/G-min 项、cli B2 项全部通过）。幂等哈希不含 entry/recorded_at 的修复已核对代码与测试断言（`b2-human-events.test.ts:54`）。

## 4. 问题

无返工项。开发中修复（幂等哈希初版含 recorded_at 导致任何重放必冲突）已在代码与测试层验证到位。诚实边界（`human_authorization_events` 生产声明在 B2 时点仍 false）与声明翻转条件已在 B3 落地，由本系列验收整体背书（见 B3 报告 §4）。

## 5. 结论与后续

**PASS**。B2 通过后，`human_authorization_events` 翻转（B3 已落地）获得证据背书；G-min 对接面（GUI 确认按钮只调 `submitHumanEvent`）就绪。B3 可开工。
