# P5-H 增量 B0+B1 独立验收：契约预留与会话身份验证

日期：2026-10-24
验收方：独立验收 Agent；未修改产品实现、未发送模型任务
结论：**PASS**

## 1. 范围、前置与基线

验收对象为 P5-H 收口计划首个增量 B0+B1（ADR-0011），开发报告 `P5-H-b1-development.md`。基线为 HEAD `a083874e60e7a40d88a18e075b699b1fb818b0e1` 加未提交工作区（含前序 P5-R/P5-A/P5-H 改动与本增量）；与后续 B2/B3/G-min/B4 共用同一棵树。经文件 mtime 核验，自 B4 全量门禁证据产生（2026-10-24 12:05）后无任何源码改动，本报告结论对最终树有效。

## 2. 逐项核验

| 验收条件 | 实际行为与证据 | 判定 |
| --- | --- | --- |
| Schema `human-authorization-event` | `packages/protocol/schemas/human-authorization-event.schema.json` 实读：事件事实与端口逐字段对齐，全字段 required、`additionalProperties:false`、entry 枚举 `cli-console\|gui-confirm`；3 项协议契约测试在全量门禁通过。 | 满足 |
| owner 操作 `authorizations.submitHumanEvent` 契约预留 | `service-control-operation.schema.json` 新分支存在；anchor.ts 与服务分发均先经 Schema 校验。调用面见 B2 实现；本增量按计划未实现服务端。 | 满足 |
| TS 镜像与端口统一 | `protocol/src/types.ts` 新增三类型；core `ports/adapter.ts` 无本地重复定义；typecheck 全量（含 tests）通过。 | 满足 |
| 连接器工具契约 | `docs/zcode-connector-tools.md` §1–§5 实读：握手能力发现、凭据 helper 边界、§4.2 resume-first 存在性判据、§4.3/§4.4 草案均在。 | 满足 |
| 阶段文档修订 | AGENTS.md、DESKTOP_GUI_PLAN §8、prompts/README.md 续作表、adapters/README.md 均含 B0–B4 与 G-min 条目。 | 满足 |
| 参考连接器（B1） | `reference-connector.ts` 实读：MCP stdio 服务器，内部 spawn 官方 `app-server`；CLI 入口无默认路径（`--cli`/`ZCODE_CLI_ENTRY` 注入），不读凭据存储，无 helper 时 header 请求如实失败（`headersApplied:false`）。 | 满足 |
| 客户端能力协商 | `connector.ts:53-57`：握手后 `tools/list`（5 秒超时），失败降级空集=全部门禁拒绝；适配器各工具按 `tools.has(...)` 门禁（B1/B3/B4 测试均断言 `ADAPTER_CAPABILITY_MISSING` 且零调用）。 | 满足 |
| `verifyExternalSession` | 实读 `adapters/zcode/src/index.ts:107-132`：格式校验→工具声明门禁→首验绑定 host↔subject→主体冲突确定性 false→连接器失败/畸形/工作空间回显不一致一律 uncertain→`identity_verifications` 留痕。四类 fixture 测试断言绑定固化、重启保持、不伪造否定。 | 满足 |
| 真实探针证据 | `evidence/2026-10-24-p5-h-b1/`：Run1 全新 journal `verified:true`、伪造会话 `false`、主体冲突 `false`、exit 0；`journal-dump.txt` 实读恰 1 条绑定 + 6 条验证记录（true×1、false×5）时间戳齐全；Run2 `verified:false`（零轮次会话不跨 app-server 实例存活的诚实呈现，后经 B3 载入轮持久化 + 连接器 journal 权威化在契约层解决）。 | 满足 |
| 声明纪律 | B1 期生产声明 `current_session_identity:false`（探针输出可见），翻转发生在 B2 并由本系列验收整体背书（见 B2 报告 §4）。 | 满足 |

## 3. 独立验证

本机实跑全量门禁（typecheck + 40 文件 418 测试）：typecheck 通过；417 过、1 失败为 `packages/core/test/rework.test.ts` 负载敏感屏障用例超时——经单测三次独立复跑（18–20s）通过、该文件相对 HEAD 无改动（属已验收 P5-R 范围）、同一树开发方证据 418/418 过，裁定为环境性超时而非本增量回归，详见 `P5-H-b4-review.md` F1。协议契约测试（含 3 项新 Schema 测试）、参考连接器真实 stdio 进程测试（2 项，含"注入 CLI 入口不可用时如实 uncertain"）均在本轮门禁通过。

## 4. 问题

无返工项。边界发现（`session/read` 非确定性否定、零轮次会话不跨实例存活）已固化为契约 §4.2 并在后续增量实测闭合，不再列问题。

## 5. 结论与后续

**PASS**。B1 通过后，`current_session_identity` 翻转（B2 已落地）获得证据背书。B2（真人授权入口）可开工。
