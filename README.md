# RoleDock 角色坞

**一个支持自定义 Agent 角色、文档化知识、会话继承和独立协作请求的通用协议框架。**
*A framework for persistent agent roles, document-based knowledge, session handoff, and isolated collaboration across harnesses.*

Role 表示可长期持续的职责身份，Dock 表示角色接入不同 Harness 的统一位置：角色知识持续积累，会话按明确状态接续。

> 状态：**原型开发中（P3 已完成，待独立验收）**。角色包、SQLite 状态层、单协调器锁、能力策略、版本文档、CheckpointBuilder、知识导出导入、sessions.open/resume 与安全交接（唯一最新继承者）已实现（Mock 适配器验证状态机制，真实宿主验证在 P5）；未实现操作如实返回 `NOT_IMPLEMENTED`。

## 它解决什么问题

- **角色可插拔**：任意角色以声明式包接入（职责、文档模板、输出 Schema、能力需求），核心不含任何业务角色枚举。
- **知识可积累**：角色文档版本化发布；数据库是权威来源，Markdown 导出是带版本材料。
- **会话可接续**：交接 = 不可变 BootstrapBundle + 事务内比较并交换主指针；每角色唯一当前继承者，旧实例自动失去发布权。
- **协作不打扰**：协作请求在接收事务内绑定最新继承者与知识快照，在隔离的独立会话执行，结果走收件箱归并，不注入用户主会话。
- **Harness 可适配**：公开适配契约（必选能力 + 协商能力），通用分支路径不依赖宿主原生 fork。

## 仓库结构

```text
packages/protocol   协议契约：JSON Schema、TS 类型、错误码、校验
packages/core       协调器：SDK 操作面（分阶段实现）
packages/cli        roledock 命令行（--json 机器可读输出）
adapters/           Harness 适配器（P5）
examples/           示例角色包（P1+）
docs/spec|adr       规范与架构决策
tests/              一致性、集成测试与样例
```

## 快速开始（开发）

```bash
nvm use        # Node 22.23.2
npm ci
npm run check  # typecheck + build + 全部测试
node packages/cli/dist/bin.js --help
```

## 文档

- 开发蓝图：[docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)
- 规范：[docs/spec/](docs/spec/)（对象与状态机、身份与权限、SDK 操作、适配契约）
- 架构决策：[docs/adr/](docs/adr/)
- 环境基线：[docs/toolchain.md](docs/toolchain.md)

## 许可证

Apache-2.0。发布与托管位置在发布阶段（P6）确定。
