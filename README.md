# RoleDock 角色坞

**一个支持自定义 Agent 角色、文档化知识、会话继承和独立协作请求的通用协议框架。**
*A framework for persistent agent roles, document-based knowledge, session handoff, and isolated collaboration across harnesses.*

Role 表示可长期持续的职责身份，Dock 表示角色接入不同 Harness 的统一位置：角色知识持续积累，会话按明确状态接续。

> 状态：**原型开发中；2026-10-14 P5-R 本地返工独立验收 PASS，P0–P4 PASS，P5 整体 BLOCKED（G01）**。协议 0.1 的 18 项 SDK 操作已有代码；依据 [原复验报告](docs/phase-reports/P0-P5-revalidation.md) 完成 R01–R15 与 N01 返工，P5-R时点门禁记录 28 文件、334 项测试全部通过，见 [独立验收报告](docs/phase-reports/P5-R-review.md)。当前P5-H受限实现门禁为36文件、386项测试通过；Mock／fixture和真实模型诊断均不能替代完整角色闭环，G01仍有接口/证据缺口。

产品方向已调整为**桌面管理 GUI + 外部 Harness 会话接入**：用户在会话中授权角色，Agent 执行显式锚定，GUI 管理角色、知识与绑定状态。首版不自建聊天 Harness；CLI 保留作开发和诊断入口。P5-A 已实现受信授权、同会话锚定、共享服务和最小 MCP 会话工具，**Linux 本地独立验收 PASS**；其时点门禁记录34文件、372项测试全部通过，独立专项29项通过，见 [P5-A 验收报告](docs/phase-reports/P5-A-review.md)。GUI/真实角色闭环尚未实现，后续顺序见 [实施计划](docs/DESKTOP_GUI_PLAN.md)。

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
- 适配器指南：[docs/adapter-guide.md](docs/adapter-guide.md) · 快速开始：[docs/quickstart.md](docs/quickstart.md)
- 架构决策：[docs/adr/](docs/adr/)
- 环境基线：[docs/toolchain.md](docs/toolchain.md)

## 许可证

Apache-2.0。发布与托管位置在发布阶段（P6）确定。

P5-A 接口与可信边界见 [锚定规范](docs/spec/external-session-anchor.md)、[共享服务用法](docs/service-and-mcp.md)和 [ADR-0009](docs/adr/0009-trusted-connections-and-anchor.md)。原18项本地SDK与新增受信连接面分别列出；不将Mock锚定或MCP进程通信当作真实宿主证据。

P5-H 已按用户指定的 ZCode 实施受限诊断接入，已取得 GLM-5.3 真实答案；独立验收确认本地边界通过、完整角色闭环仍因人类来源、材料确认、隔离及资源控制接口缺口保持 **BLOCKED**，见 [ZCode 接入说明](docs/zcode-integration.md)、[开发报告](docs/phase-reports/P5-H-development.md)及 [独立验收](docs/phase-reports/P5-H-review.md)。诊断成功不代表角色锚定或独立请求完成。
