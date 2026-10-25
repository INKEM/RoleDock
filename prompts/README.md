# RoleDock 分阶段开发提示词

把本蓝图的 `docs/` 和 `prompts/` 放入目标仓库。每轮给开发 Agent 一份对应阶段提示词；提示词会要求它读取共同约束、开发计划和前序验收报告。

首次执行用 P0。只有当前阶段独立验收通过，才执行下一阶段。提示词中的阶段标签、报告路径及待交付接口都是开发目标，不代表已经存在。

2026-10-13 起按 [当前工作区复验](../docs/phase-reports/P0-P5-revalidation.md) 和 [桌面／外部锚定计划](../docs/DESKTOP_GUI_PLAN.md)继续：P0 PASS、P1–P5 REWORK，真实 Harness 另有 BLOCKED 缺口。P0–P5 原提示词保留历史验收要求；当前先执行 P5-R，不能根据旧 PASS 直接开始候选版。

| 顺序 | 提示词 | 目标 |
| --- | --- | --- |
| P0 | [00-contract-and-scaffold.md](00-contract-and-scaffold.md) | 固化通用契约，创建可运行仓库骨架 |
| P1 | [01-roles-and-store.md](01-roles-and-store.md) | 接入自定义角色包和持久状态 |
| P2 | [02-documents-and-knowledge.md](02-documents-and-knowledge.md) | 实现版本化文档和交接知识 |
| P3 | [03-session-handoff.md](03-session-handoff.md) | 实现唯一继承者及安全交接 |
| P4 | [04-isolated-requests.md](04-isolated-requests.md) | 实现独立请求及最新继承者路由 |
| P5 | [05-harness-and-demo.md](05-harness-and-demo.md) | 接入真实 Harness 并完成端到端演示 |
| P6-R | [06-open-source-candidate.md](06-open-source-candidate.md) | GUI 与真实外部锚定验收后的独立开源候选版 |

当前续作顺序（一次一个子阶段，独立验收后再继续）：

| 阶段 | 提示词 | 门槛 |
| --- | --- | --- |
| P5-R | [05R-runtime-rework.md](05R-runtime-rework.md) | 关闭复验 R01–R15，复验受影响原阶段 |
| P5-A | [05A-authorization-and-anchor.md](05A-authorization-and-anchor.md) | 受信授权、现有外部会话锚定、共享服务和最小 MCP 工具 |
| P5-H 增量 B0–B4 | 按 ADR-0011 与 `docs/zcode-connector-tools.md` 续作，报告 `P5-H-bN-development.md` | B1 会话身份验证、B2 真人授权入口内部接口、B3 材料载入对账、B4 隔离实证与资源控制；每增量独立验收 |
| G-min | GUI 最小授权确认面（自 P6-G 提前，ADR-0011） | 受信入口确认→recordHuman→锚定全链，关闭 G01-Z01 |
| P5-H 增量 B5（ADR-0012） | 按 `docs/ADAPTER_SANDBOX_PLAN.md` 续作，报告 `P5-H-b5N-development.md` | 适配器强制隔离（沙箱执行边界）关闭 G01-Z03：B5-0 契约→B5-1 技术验证→B5-2 逃逸证据→B5-3 请求链受管接入→B5-4 翻转收口；每增量独立验收 |
| P6-G | [06G-desktop-management.md](06G-desktop-management.md) | 桌面管理 GUI，聊天仅通过外部 Harness 接入 |
| P6-R | [06-open-source-candidate.md](06-open-source-candidate.md) | GUI／锚定／原 v0.1 条件全部有证据 |

每个阶段完成后，把 [REVIEW.md](REVIEW.md) 交给另一个验收 Agent，给定阶段编号和代码基线。需要返工时使用 [REWORK.md](REWORK.md)。这种开发／验收安排是本项目的实施流程，框架自身仍允许任意角色组织。

可向 Agent 使用以下入口语句：

```text
请读取 prompts/00-contract-and-scaffold.md 并执行 P0。
当前目标仓库就是工作目录。先读取仓库指令与蓝图，再完成该阶段交付、验证和报告。
```

后续按编号替换文件名。若 Agent 没有文件读取能力，则粘贴 COMMON.md、开发计划相关章节及当前阶段提示词；下一位 Agent 同时获得上一阶段报告。

验收入口示例：

```text
请按 prompts/REVIEW.md 验收 P2。
基线以当前工作区为准，记录实际提交标识或 diff 摘要。
独立检查要求和测试，不把开发报告当作结论；产出明确的通过或返工意见。
```
