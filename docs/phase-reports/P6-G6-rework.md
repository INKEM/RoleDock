# P6-G6 返工记录(R1)

日期:2026-10-28。对应验收:`P6-G6-review.md`(结论 REWORK,唯一返工项 R1,中优先级)。返工基线:HEAD `4289c18` 起。

## R1:契约定档的输入面未落地(时间过滤 / inbox.list 分页)

- **验收指认**:`requests.listInbox` 契约 §2.3 与计划 §14 均声明"时间过滤",实现只有 state/role;`inbox.list` 按 §2.1 通用约定应分页,实现为全量返回,且 sdk-operations.md 与契约相互矛盾。
- **裁定**:按验收方给出的两个选项中选择**实现**(十余行+测试),不修订契约。
- **修复**:
  1. `requests.listInbox` 增 `created_since`/`created_until`(ISO date-time,服务 Schema 分支+admin 过滤+非法时间 `VALIDATION_FAILED`);service 测试断言时间过滤与非法输入拒绝。
  2. `inbox.list` 分页:`{cursor?, limit?}`(1–200 默认 50,offset 游标,`policy.list` 先例),响应增 `next_cursor`;core `listSessionInbox`、coordinator 输入校验、anchor map optional、MCP 工具 schema、sdk-operations.md 同步更新。
  3. 采纳验收建议:服务层"接受期取消"确定性用例——`WorkspaceService.start(pollMs: 800)`(可配置,验收方指正开发报告 §8.2 "无法确定性复现"结论过强),真实 RPC 面上 accepted→cancelled+同键重放+审计事件;并修正清理断言语义(接受期取消无分支会话可回收,cleanup_pending 合理为 false;真实 pending/失败路径由 core Held 夹具覆盖)。
- **复验运行**(全部退出码 0):
  - `npx vitest run packages/service/test/g6-requests-inbox.test.ts`:2/2 PASS(含新确定性取消与时间过滤)。
  - `npm run check`:**553/553 PASS(59 文件)**。
  - shell E2E 全量:**15/15 PASS**。

## 观察项跟进(不阻塞)

- 真机截图(G4/G5/G6)随 G7 收口(验收观察项)。
- owner 取消 running 不调 `adapter.cancel` 协商中断、依赖回收循环 closeSession——记录为 G7 GUI 真机确认项(验收建议已记入)。

## 结论

R1 已按"实现"路径修复并复验通过,契约 §2.3/§2.1 定档面完整落地。进入下一子阶段(G7,先计划留档)。
