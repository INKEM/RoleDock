# P6-G-min 独立验收：GUI 最小授权确认面

日期：2026-10-24
验收方：独立验收 Agent；未修改产品实现、未发送模型任务
结论：**PASS**

## 1. 范围与基线

验收对象为 G-min（ADR-0011 决策 3：GUI 确认面自 P6-G 提前，作为 G01-Z01 真人来源的受信入口），开发报告 `P6-G-min-development.md`。基线与 `P5-H-b1-review.md` §1 相同。

## 2. 逐项核验

| 验收条件 | 实际行为与证据 | 判定 |
| --- | --- | --- |
| 授权请求列表 → 确认入口 | `packages/desktop/src/index.ts` 实读：确认页列出已注册外部会话（host/主体/现存有效授权）、逐会话选角色/能力/继承/有效期；拒绝=不操作（协议无拒绝对象，不虚构）。 | 满足 |
| 调 `submitHumanEvent`，复用 owner 凭据 | bin.ts 实读：owner-connection.json 属主+0600 校验（uid 与 mode 位检查）；经 `ServiceClient` 以 owner 凭据代理且仅代理三个操作（`externalSessions.list`/`roles.list`/`authorizations.submitHumanEvent`）；entry 固定 `gui-confirm`，event_ref 由受信进程生成（`gui-<时间>-<随机>`）。 | 满足 |
| 页面不可伪造 host/subject | `confirmInput` 从服务端 `externalSessions.list` 结果解析 host/subject/body 校验，页面输入仅提供 external_session_id/role_id/capabilities/inherit/expires_hours；已有效授权会话拒绝重复确认（`INVALID_STATE_TRANSITION`）。desktop 测试 3 项实读断言：页面不含 token 且 GET / 零写面调用、确认 provenance 正确、重复/未知/畸形拒绝且零 `submitHumanEvent` 调用。 | 满足 |
| 渲染层无凭据/写库/宿主命令 | 同上测试；API 为同源 loopback JSON（默认绑定 127.0.0.1），请求体 256KiB 上限。 | 满足 |
| 技术基线 | Node 内置 http + 纯浏览器页面，零新增依赖；`docs/toolchain.md` "G-min 桌面确认面技术基线"段存在。 | 满足 |
| `externalSessions.list` Schema 先行 | `service-control-operation.schema.json` 扩展存在；核心 `listExternalSessions` 撤销状态以 `revoked_at` 列为准（record_json 不随撤销更新——开发中修复，core G-min 测试断言撤销后 `active_authorization:null`）。 | 满足 |
| 真实全链证据 | `evidence/2026-10-24-p5-h-gmin/1-gmin-e2e.log` 实读：真实 zcode 适配器服务启动（0600 owner-connection）→ 真实会话经受信通道注册（生产 `current_session_identity:true`）→ GUI 页面/视图/确认（`{ok:true,entry:"gui-confirm"}`）→ 受信通道 recordHuman 产出授权（source human-event，event_ref `gui-…`）→ `sessions.anchor` 真实材料载入轮 → attempt active、load_version 1、binding active generation 1 → 列表复核显示有效授权。`2-store-dump.txt` 三层审计一致，entry=gui-confirm。 | 满足 |
| 声明纪律 | 载入声明在证据链中为 fixture 翻转且输出注明（`load_declarations` 字段）；G-min 不声称隔离或载入能力证明。载入生产翻转随 B4 验收背书。 | 满足 |

## 3. 独立验证

全量门禁实跑通过（除 `P5-H-b4-review.md` F1 环境性超时外，desktop 3 项、core G-min 1 项、service G-min 1 项全部通过）。

## 4. 问题

无返工项。两点边界如实记录，不阻塞本阶段：

1. **浏览器人工点击流未采集**（P3，记录项）：证据经与页面同一 HTTP 端点采集，页面 JS 为静态资源留档。人工点击的验收属 P6-G 正式验收矩阵，ADR-0011 决策 3 将 G-min 定位为受信入口交付，本验收条件不要求人工点击证据。P6-G 验收时须补真实浏览器操作矩阵。
2. **拒绝（decline）不落任何记录**：协议无拒绝对象，页面拒绝=不操作。诚实设计；若后续需要拒绝审计须先修订协议。

## 5. 结论与后续

**PASS**。G01-Z01 的 GUI 侧受信入口交付完成；真人来源闭环=cli-console（B2）+ gui-confirm（本增量）两条受信入口均有真实全链证据。P6-G 正式阶段（五页面/桌面容器）前置仍为 P5-H 复验通过，本增量通过不等于 P6-G 开工。
