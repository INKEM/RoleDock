# RoleDock 分阶段开发提示词

把本蓝图的 `docs/` 和 `prompts/` 放入目标仓库。每轮给开发 Agent 一份对应阶段提示词；提示词会要求它读取共同约束、开发计划和前序验收报告。

首次执行用 P0。只有当前阶段独立验收通过，才执行下一阶段。提示词中的阶段标签、报告路径及待交付接口都是开发目标，不代表已经存在。

2026-10-25 当前入口：[B5-4 独立验收](../docs/phase-reports/P5-H-b5-4-review.md)已关闭 G01-Z03、解除 P5-H BLOCKED，P5 整体通过。G-min 已完成，完整 P6-G 尚未实施。按 [桌面计划](../docs/DESKTOP_GUI_PLAN.md)从 **P6-G0** 开始；旧返工和 B 系列提示保留作历史，不重复执行已验收阶段。

| 顺序 | 提示词 | 目标 |
| --- | --- | --- |
| P0 | [00-contract-and-scaffold.md](00-contract-and-scaffold.md) | 固化通用契约，创建可运行仓库骨架 |
| P1 | [01-roles-and-store.md](01-roles-and-store.md) | 接入自定义角色包和持久状态 |
| P2 | [02-documents-and-knowledge.md](02-documents-and-knowledge.md) | 实现版本化文档和交接知识 |
| P3 | [03-session-handoff.md](03-session-handoff.md) | 实现唯一继承者及安全交接 |
| P4 | [04-isolated-requests.md](04-isolated-requests.md) | 实现独立请求及最新继承者路由 |
| P5 | [05-harness-and-demo.md](05-harness-and-demo.md) | 接入真实 Harness 并完成端到端演示 |
| P6-R | [06-open-source-candidate.md](06-open-source-candidate.md) | GUI 与真实外部锚定验收后的独立开源候选版 |

当前续作顺序（一次一个子阶段，独立验收后继续；总入口 [06G-desktop-management](06G-desktop-management.md)）：

| 阶段 | 提示词 | 交付 |
| --- | --- | --- |
| P6-G0 | [06G0-contract-and-spike](06G0-contract-and-spike.md) | 技术探针、owner API／动作契约和版本定档 |
| P6-G1 | [06G1-shell-and-runtime](06G1-shell-and-runtime.md) | 外壳、IPC、服务生命周期 |
| P6-G2 | [06G2-workspaces-and-roles](06G2-workspaces-and-roles.md) | 工作空间／接入预检、角色和策略 |
| P6-G3 | [06G3-session-authorization](06G3-session-authorization.md) | 原 ZCode 桌面会话、受信确认、Agent 显式锚定 |
| P6-G4 | [06G4-session-observability](06G4-session-observability.md) | 绑定／载入／代次、撤销与恢复观察 |
| P6-G5 | [06G5-knowledge](06G5-knowledge.md) | 知识／历史／候选／迁移 |
| P6-G6 | [06G6-requests-and-inbox](06G6-requests-and-inbox.md) | 请求、产物与收件箱 |
| P6-G7 | [06G7-release-validation](06G7-release-validation.md) | 桌面全链、可靠性、安装包与总体验收 |
| P6-R | [06-open-source-candidate](06-open-source-candidate.md) | G7 和 P6-G 总体验收通过后的开源候选 |

历史续作：P5-R → P5-A → P5-H B0–B4／G-min → B5-0…B5-4 均已按相应报告验收；原提示词和证据保留。当前报告命名为 `P6-Gn-development.md`／`P6-Gn-review.md`，不是每个子阶段覆盖同一个 P6-G 报告。

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

当前开工示例：

```text
请读取 prompts/06G0-contract-and-spike.md，只执行 P6-G0。
根据最新代码和 B5-4 收口验收，先完成技术探针、GUI 操作契约与工具链定档；
报告写为待独立验收，不提前实现后续页面。
```
