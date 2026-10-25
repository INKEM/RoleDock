# P5-H 增量 B4 独立验收：资源控制、继承与 05H 链复验（收口增量）

日期：2026-10-24
验收方：独立验收 Agent；未修改产品实现、未发送模型任务
结论：**PASS**（增量自身验收条件满足；G01-Z03 残余如实 BLOCKED，P5-H 不虚称收口）

## 1. 范围与基线

验收对象为 P5-H 收口计划收口增量 B4，开发报告 `P5-H-b4-development.md`。基线与 `P5-H-b1-review.md` §1 相同；经 mtime 核验本报告即验收最终树。

## 2. 逐项核验

| 验收条件 | 实际行为与证据 | 判定 |
| --- | --- | --- |
| `zcode_cancel`/`zcode_close` | 官方 `session/stop`（中止当前轮；空闲诚实 no-op）与 `session/close`（宿主删除事件存储；`closed` 原样上报）实现在参考连接器与适配器；适配器 `cancel` 连接器失败一律 uncertain、`closeSession` closed:false 与信号丢失均 uncertain、closed 句柄操作 `NOT_FOUND`、按创建键查询返回 null（B4 fixture 测试全断言）。真实取消证据见隔离实验。 | 满足 |
| `createSession` 带 bootstrap | intent 先行 → 裸会话创建 → 真实载入轮 + 四判据确认后才返回句柄；`capability_scope`/`temp_dir` 仍 `NOT_IMPLEMENTED`（诚实）。解锁 `sessions.open inherit=latest`：真实 gen-2 交接证据（见 05H 链步骤 5）与 fixture 级断言（generation 2、predecessor、旧主 superseded 视图）。 | 满足 |
| 支出前预算 | `1-chain.log`：过期 deadline 的发送在宿主调用前被拒，宿主事件序列号 34→34 不变（零支出）；既有 max_output_bytes 拒收与 max_turns 边界测试继续通过。 | 满足 |
| 声明翻转 | `load_materials`/`reconcile_load: true`（B3 真实锚定证据背书）、`cancel: true`（本增量真实取消证据）：`1-chain.log` capabilities 行以**生产声明**跑通步骤 1–6（3 个真实材料载入轮）。四项隔离保持 false：10 个重叠请求按设计 `ADAPTER_CAPABILITY_MISSING` 全部 failed，零宿主轮次。 | 满足 |
| 隔离实证（G01-Z03） | `2-isolation-cancel.log`：plan 模式写尝试轮运行中经官方 stop 中止 → 宿主回 idle → **目标文件始终不存在**（`file_exists:false`）；连接器 parked 交互请求从不自动应答。诚实边界：未观察到 permission 阶段（轮在工具调用前被中止），工具范围与嵌套 Agent 约束未证明——四项隔离不翻转，残余 BLOCKED。 | 部分证据成立；残余如实 |
| 05H 验收链复验 | `1-chain.log` + `3-store-dump.txt` 实读：步骤 1–6 真实跑通（真人授权→生产声明锚定→真实载入 load_version 1→propose/publish revision 1→takeover 继承 gen 2、旧实例 retired/旧 binding 视图 superseded→撤销后旧授权 revoked、successor 保持 gen 2）；步骤 7–8 按设计拒绝（隔离门禁，请求全 failed 带隔离错误，无 artifact 可采纳）。 | 满足 |
| conformance 套件未纳入 zcode | 理由成立：套件 `make()` 工厂要求全能力参考实现，zcode 诚实受限（restricted + 隔离 false），不伪造全能力变体；其契约行为由 29 项 fixture 测试覆盖。不构成返工项。 | 接受 |

## 3. 独立验证

- **全量门禁（本机实跑，Node 22.23.2）**：typecheck 通过；40 文件 418 测试中 **417 过、1 失败**。
- **F1 — P3，负载敏感测试超时（环境性，非产品回归，不阻塞）**：失败项为 `packages/core/test/rework.test.ts` "ten overlapping independent requests"（30s 超时的 10 并发屏障用例）。裁定依据：(a) 单测三次独立复跑 18–20s 连续通过（本机负载 avg 5–7，单测即耗近 20s，套件并行下超出 30s 预算）；(b) 该测试文件相对 HEAD 无改动，属已验收 P5-R 范围，B0–B4 未触碰其路径；(c) 同一工作区树在开发方 B4 证据 `full-check.log` 实跑 40 文件/418 测试全过（839s），且经 mtime 核验该证据产生后无任何源码改动。影响：全量门禁在高负载机器上可能间歇超时。修复建议（后续阶段顺手项）：该用例超时提高至 120s 或降低并行敏感度。复验：`node node_modules/vitest/vitest.mjs run packages/core/test/rework.test.ts -t "ten overlapping"`。
- 代码路径实读：`cancel`/`closeSession` 语义、closed 回收、bootstrap 创建复用 B3 载入机械、生产声明与四项隔离 false 的组合均与声明一致。

## 4. 问题与裁定

1. **F2 — P3，`retired` 实例状态未记载于规范（文档项，不阻塞）**：`invalidateBinding`（released/revoked/expired 撤回路径）将 `agent_instances` 置 `retired`（`authorization.ts:23`），而 `docs/spec/objects-and-state-machines.md` 状态机仅记载 `superseded`（后继取代路径，`handoff.ts:471`）。**裁定**：两态语义不同且区分正确——`superseded`=存在后继代际的失去主资格；`retired`=绑定撤回、无后继、主指针清空（`current_instance_id=NULL`）；两者均使正式发布被拒（均不再是 `current_instance_id`），权限语义等价。B4 报告留裁定的"交接路径 retired vs 锚定路径 superseded"实为撤回路径 vs 后继路径之别，非同一事件的措辞分歧。修复要求：规范状态机补记 `retired` 及其触发（后续文档修订，不改代码）。复验：读规范 §对象状态机。
2. **G01-Z03 残余（如实 BLOCKED）**：四项隔离未声明——独立请求与收件箱采纳按设计拒绝。这是 ZCode 平台侧需官方工具范围/嵌套 Agent 隔离机制的缺口，非本仓库可实现项。

## 5. P5-H 整体门槛现状（各增量汇总裁定）

| 门槛 | 现状 | 依据 |
| --- | --- | --- |
| G01-Z01 真人来源+会话身份 | **证据完备，可评审关闭** | B1 真实身份验证（resume-first 权威判据 + 审计）；B2 cli-console 与 G-min gui-confirm 两条受信入口的真实全链（事件→recordHuman→锚定）；宿主标签不作凭据的反例已在 P5-H 首轮记录并由受信入口方案取代 |
| G01-Z02 材料载入确认 | **证据完备，可评审关闭** | B3 四判据真实载入轮 + 内容寻址规避 24k 截断 + 跨实例 journal 对账；B4 继承链第二次真实载入 |
| G01-Z03 四项隔离 | **BLOCKED** | 平台侧机制缺口；部分证据（plan 模式权限门 + 连接器从不自动应答）不构成声明依据 |
| G01-Z04 副作用/资源控制 | **证据完备，可评审关闭** | 官方 stop/close 语义 + 支出前预算（宿主 seq 不变）+ closed 回收 + uncertain 边界 |

**G01 整体仍 BLOCKED → P5-H 未收口**；剩余缺口收敛为单一外部依赖项（宿主官方隔离机制）。

## 6. 结论与后续

**PASS**（增量验收；不等于 G01 关闭）。所有生产能力声明（`current_session_identity`/`human_authorization_events`/`load_materials`/`reconcile_load`/`cancel`）经真实证据背书成立，四项隔离诚实保持 false。不得据此宣称"真实角色闭环完成"——隔离声明未证实前，独立请求与完整产品闭环仍被核心门禁如实拒绝。下一步：向宿主侧寻求 Z03 所需的受支持隔离机制（工具范围/嵌套 Agent 约束），取得后对 05H 步骤 7–8 做真实复验；P6-G 前置为 P5-H 复验通过。
