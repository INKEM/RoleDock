# P5-H 增量 B5-0 独立验收：契约预留（ADR-0012 落档 + `--sandbox` 参数面）

日期：2026-10-25
验收方：独立验收 Agent；未修改产品实现、未发送模型任务
结论：**PASS**

## 1. 范围与基线

验收对象为 ADAPTER_SANDBOX_PLAN §3 首增量 B5-0（契约预留），开发报告 `P5-H-b5-0-development.md`。基线沿用 B0–B4/G-min 验收树（HEAD `a083874e…` + 未提交工作区）；本增量只新增契约语义与参数面，不改已验收行为路径。

## 2. 逐项核验

| 验收条件（计划 §3 B5-0） | 实际行为与证据 | 判定 |
| --- | --- | --- |
| ADR-0012 落档 | `docs/adr/0012-adapter-enforced-isolation.md` 实读：isolation.* 语义变更、效果层强制、受管执行范围、失败关闭、凭据边界、收口条件七条决策完整。 | 满足 |
| adapter-contract.md 受管执行语义 | §2 能力等级补语义修订指针（"保证"=适配器保证，验收标准是逃逸测试证据）；文末"B5：受管执行与隔离证据"节实读：五条规则（受管范围仅咨询分支、效果层强制、失败关闭、声明与证据分离、既有路径复用 + `capability_scope`/`temp_dir` 的 B5-3 解锁预告）与 ADR/计划一致。 | 满足 |
| zcode-connector-tools.md §4.5 草案 | 实读：`--sandbox` 参数语义、spawn 参数草案表（runner/可写目录/材料只读挂入/出口白名单/pid+cgroup/凭据留边界外）、runner 探测语义（缺失/启动失败/中途消亡 → NOT_IMPLEMENTED 或 uncertain）。 | 满足 |
| 阶段门文档登记 | AGENTS.md 方向段、DESKTOP_GUI_PLAN §8 B5 行、prompts/README.md 续作表 B5 行核对一致（计划决策时落档，本增量核对未改）。 | 满足 |
| `--sandbox` 参数预留（默认关闭） | `reference-bin.ts` parseArgs boolean 默认 false；`createReferenceConnectorServer` 在建立任何连接或 spawn 任何子进程前对 `sandbox === true` 抛 `NOT_IMPLEMENTED`（失败关闭）。证据 `sandbox-refusal.log`：实跑退出码 1 + NOT_IMPLEMENTED 信封；真实进程测试断言非零退出 + 信封（全行扫描提取，规避 Node SQLite 实验警告顺序不稳）。 | 满足 |
| 全量门禁绿 | 开发方 `full-check.log`：40 文件 / 419 测试全过（B4 的 418 + 1 项新拒绝测试）；本验收方独立门禁见 B5-1 报告 §3（同一树终态 432/432 全过）。 | 满足 |
| 四项声明不变 | `adapters/zcode/src/index.ts:57` 实读：`isolation` 四项全 false、`level:"restricted"`；`capability_scope`/`temp_dir` 的 NOT_IMPLEMENTED 拒绝原样保留。 | 满足 |

## 3. 独立验证

- `sandbox-refusal.log` 行为独立复核：预留语义即"启用即拒绝"已由代码路径（连接器构造入口、先于 transport 建连）与测试双重确认。
- 版本纪律核对：`REFERENCE_CONNECTOR_VERSION` 保持 0.3.0（工具集未变；B5-1 因受管 spawn 行为实质变化才递增 0.4.0，处理正确）。
- 后续演进核对：B5-0 的拒绝测试在 B5-1 被改造为 `ROLEDOCK_SANDBOX_PROBE=unavailable` 机器自适应（本机 bwrap 可用，不覆盖则受管路径正常启动）——覆盖只允许"更严格"方向，属恰当演进，不影响本增量证据在其基线的有效性。

## 4. 问题

无返工项。诚实边界与报告一致：`--sandbox` 在 B5-0 只是参数面，无任何沙箱行为；不构成隔离证明。

## 5. 结论与后续

**PASS**。B5-1（沙箱执行器技术验证）可开工。
