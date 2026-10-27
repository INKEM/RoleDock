# P6-G0 返工独立复验

最新裁定：见 [P6-G0-final-review.md](P6-G0-final-review.md)，第二次返工独立复验 **PASS**；下文保留上轮 REWORK 历史。

日期：2026-10-26。结论：**REWORK**。首轮 R02、R04 已关闭；R01、R03 尚未完全关闭。技术探针仍通过，G0 独立 PASS 前置尚未成立。

## 1. 范围与基线

按 `prompts/REVIEW.md`、`06G0-contract-and-spike.md`、开发蓝图、toolchain、桌面计划、ADR-0013 和 [首轮报告](P6-G0-review.md) 复验。被审查内容为 `P6-G0-development.md` §9 与当前 v2 契约；同时存在 G1 未提交交付，不将其完成声明作为 G0 通过依据。

HEAD：`d9743365256459a773a5319791cf3b7bb2e5fbe7` + 当前未提交工作区。主验收检查运行与整合，独立协作验收者检查 R01–R04 与协议类型。没有修改产品或被审查契约。源码、测试及契约共 40 文件的前后哈希一致，见 [基线核对](evidence/2026-10-26-p6-g01-independent/baseline-verification.json)。首轮报告保留历史，本报告为本次返工裁定。

## 2. 返工逐项结果

| 原编号 | 结果 | 独立核对 |
| --- | --- | --- |
| R01 | **未关闭** | `authorization_id` / `active_authorization` 已保留，秘密字段拒绝与合成 Bearer 文本掩盖生效；但公开内容哈希与部分合法宿主标识仍被改写，见下文 |
| R02 | **关闭** | §6 覆盖全部八种真实请求状态、同键重放、不同键终态拒绝、running 的 cancel 能力、execution_uncertain、cleanup_pending、迟到拒收与通知无发布权；G6 实现另验 |
| R03 | **未关闭** | 修订发现、候选正文/基线、产物正文/哈希、runtime、cleanup 已补；实际 checkpoint 摘要与待办仍无输出契约 |
| R04 | **关闭** | ADR 和计划回退为开发候选、待独立验收，并保留首轮 REWORK。G1 开工偏差按开发报告记载的用户指示记录，本次不另要求确认；仍不视为 G0 PASS |

### R01（续）— [P2] 自由文本脱敏仍应用于结构化公开哈希／标识

**位置**：`packages/desktop/src/probe/shared/bridge.ts:52–68`；G1 副本 `packages/desktop/src/shell/shared/redact.ts:17–33`；契约 §3.1。

**触发与实际结果**：对带有 64 位十六进制 `content_hash`、32 位十六进制 `host_session_id`、长十六进制 `event_ref` 的合成 DTO 调用当前源码 `redact()`，得到 `content_hash="[masked]"`、`host_session_id="[masked]"`、`event_ref="event-[masked]"`。完整输入、输出与布尔断言见 [复现结果](evidence/2026-10-26-p6-g01-independent/g0-redaction-repro.json)，可从仓库根目录用 Node 22.23.2 执行同目录 `g0-redaction-repro.mjs` 重现。

**影响**：契约明确允许的业务值不能保真；后续哈希比对与会话关联无法依赖返回值。此反例证明数据被改写，不声称已泄露真实凭据。

**修复要求**：将已验证 DTO 的公开结构化标识／哈希与自由文本显示分开；秘密字段继续不返回，自由文本继续按既定显示规则处理。两个桥接实现须一致；不能简单取消所有秘密字段防护，也不能依靠样例 ID 较短来规避。

**复验**：保留现有授权 ID、秘密字段、文本测试，增加实际 SHA256、32/64 hex 宿主 ID、合法事件引用的精确相等断言；probe 与 shell 实际桥接都不得改写这些公开值。

### R03（续）— [P2] checkpoint 元数据不能替代交接摘要与真实待办

**位置**：`docs/spec/desktop-gui-contract.md:47、74`；对照 `packages/protocol/src/types.ts:118–144`、桌面计划角色知识页和 `prompts/06G5-knowledge.md`。

**触发**：按 `checkpoints.list` 当前最小输出，只能获得 ID、代次、知识版本、material_hash、时间；既没有 `handoff_summary.body`，也没有 `todos[{description,done}]`。§2.2 将“待办”改成 binding 引用缺失／过期，这属于状态诊断，无法读出已有 Checkpoint.todos。取证见 [契约差异](evidence/2026-10-26-p6-g01-independent/g0-checkpoint-contract-gap.txt)。

**影响**：G5 的摘要／待办展示依然没有完整查询路径；同时 §2.2 声称首版页面行为无裁剪，与计划不符。

**修复要求**：在具名读操作中定义真实摘要、待办的获取、分页／详情方式及 owner 可见性，明确私有内容隐藏时返回什么。可扩充现有候选操作或明确复用已有操作，不强制新增 RPC；不能用引用缺失诊断替代业务待办。G0 只要求契约，不要求提前实现 G5。

**复验**：从角色知识页的“摘要”和“待办”动作能查到实际内容字段及可见性规则，字段语义与协议一致，且不借会话身份或直接 SQL 绕过读取边界。

## 3. 本轮独立运行

统一证据目录：[2026-10-26-p6-g01-independent](evidence/2026-10-26-p6-g01-independent/)。Node 22.23.2 / npm 10.9.8；socket 与 Electron 检查在自动审批允许的本地环境运行，仅临时 mock 工作空间，无真实模型任务。

| 验证 | 结果／证据 |
| --- | --- |
| `npm run typecheck` | exit 0，`01-typecheck.log` |
| desktop / probe-contract / shell-contract / service / client-timeout / mcp 六文件专项 | **27/27 PASS**，`02-targeted-tests.log`；包含 probe-contract 六项，并非两次计数 |
| `npm run desktop:build` | exit 0，`07-build-probe.log` |
| G0 真实 Electron E2E | **1/1 PASS**，`08-probe-e2e.log`：IPC、服务检查、单 writer、关窗留服务、单实例、退出回收 |
| 合成脱敏反例 | 执行成功，公开哈希／标识保真断言为 false，见 R01 |

首轮已验证的独立 Node／SQLite／MCP／dir 打包技术路线仍可保留。本轮未重跑 G0 安装包或原生目录真实点选；fixture 不计为真实点选成功。未重跑 `npm ci` 或全量 `npm run check`；开发方 462/487 测试日志仅作开发证据。G1 的独立窗口、打包与生命周期结果见 [G1 报告](P6-G1-review.md)。

## 4. 下一步

修复剩余 R01、R03，保留 R02/R04 关闭记录，更新返工说明后独立复验。**G0 仍为 REWORK；不自动推进 G2，不提交、合并或发布。**
