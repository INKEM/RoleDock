# P5-H 增量 B3 独立验收：材料载入与对账（G01-Z02）

日期：2026-10-24
验收方：独立验收 Agent；未修改产品实现、未发送模型任务
结论：**PASS**

## 1. 范围与基线

验收对象为 P5-H 收口计划第三增量 B3，开发报告 `P5-H-b3-development.md`。基线与 `P5-H-b1-review.md` §1 相同。

## 2. 逐项核验

| 验收条件 | 实际行为与证据 | 判定 |
| --- | --- | --- |
| 载入协议四判据 | `reference-connector.ts` `verifyLoadWindow`/`windowVerdict` 实读：唯一 turn.started 含载入头 → 成功未截断的工具结果携带材料头（结构性"宿主真实读取"）→ 终态响应精确标记行 → load_version 按确认顺序编号；失败/缺失/多轮一律 `unknown` 附 reason。契约 §4.3 与代码一致。 | 满足 |
| 24k 截断规避 | 材料走内容寻址文件（头两行键+sha256，正文完整 payload），不进上下文注入通道；适配器 `loadExternalMaterials` 发送前哈希预校验，篡改先 `VALIDATION_FAILED` 且零宿主调用（B3 fixture 测试断言）。 | 满足 |
| 意图先行与对账 | 连接器 intent 先落 journal 再发送；`lookupLoad` 活实例事件窗口验证 → journal 重放（`session/events` 不回放 resume 前历史的边界已实测并写入契约）；适配器 `lookupExternalLoad`：无本地 intent=`absent`、loading=对账、confirmed=重放；失败一律 `unknown` 不假确认（fixture 测试断言 `{state:"unknown"}`）。 | 满足 |
| 适配器轮询边界 | 300s 期限；宿主待人/权限请求即时 uncertain（"需要操作员而非重试"）；超时保持 loading 意图并 uncertain，核心 drive 走 `lookupExternalLoad` 权威对账。 | 满足 |
| provider 注册边界 | helper 契约扩展 `{bootstrap:{builtinPath}}`→`provider/updateAccountConfig`；子进程每次重启重执行（实测缺陷已修复并注释）；连接器不读凭据存储。 | 满足 |
| 真实锚定激活链 | `evidence/2026-10-24-p5-h-b3/1-anchor-e2e.log` 实读：真实会话以生产 `current_session_identity:true` 注册；真人事件经 owner 面（cli-console）以生产 `human_authorization_events:true` 写入；recordHuman 产出授权（source human-event）；`sessions.anchor` 驱动**真实模型轮**（GLM 读取内容寻址材料文件）→ 四判据确认 `load_version:1` → CAS 激活 attempt active、binding active generation 1、capabilities `["documents.read"]`。`2-store-dump.txt` 三层审计（核心 store/连接器 journal/适配器 journal）一致。 | 满足 |
| 声明纪律 | `load_materials`/`reconcile_load` 生产声明保持 false；真实链以 fixture 翻转子类运行且输出注明（`AnchorProbeAdapter`，bin.ts:24-29）。翻转发生在 B4 并由本系列验收背书（见 B4 报告 §4）。`human_authorization_events:true` 翻转以 B2 证据背书，本增量真实链以生产声明运行。 | 满足 |

## 3. 独立验证

全量门禁实跑通过（除 `P5-H-b4-review.md` F1 环境性超时外，zcode B3 4 项全部通过：门禁拒绝、篡改拒绝、全链 CAS 激活含 DB 断言 `role_heads.generation=1`、unknown 不假确认）。

## 4. 问题

无返工项。边界发现（session/send 强制 provider/model、注册表随子进程清空、150s 期限不足）均有复现日志并已修复；四次失败运行以 uncertain/failed 如实落地，无假成功。诚实边界（载入确认不证明工具范围隔离）与开发报告一致；G01-Z02 的载入侧证据据此完备。

## 5. 结论与后续

**PASS**。B3 通过后，`load_materials`/`reconcile_load` 翻转（B4 已落地）获得证据背书；05H 验收链前四步具备真实宿主证据。B4 可开工。
