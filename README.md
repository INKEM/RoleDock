# RoleDock 角色坞

**一个支持自定义 Agent 角色、文档化知识、会话继承和独立协作请求的通用协议框架。**
*A framework for persistent agent roles, document-based knowledge, session handoff, and isolated collaboration across harnesses.*

Role 表示可长期持续的职责身份，Dock 表示角色接入不同 Harness 的统一位置：角色知识持续积累，会话按明确状态接续。

> 状态：**2026-10-25 P5-H B5-4 独立验收 PASS，G01-Z03 关闭，P5-H 与 P5 整体解除 BLOCKED**。P5-R/P5-A/G-min 已验收；最新报告记录 42 文件、449 项测试通过，并有真实受管八步链与十重叠请求证据，见 [B5-4 独立报告](docs/phase-reports/P5-H-b5-4-review.md)。

产品方向为**桌面管理 GUI + 外部 Harness 会话接入**。现有 `packages/desktop` 是 G-min 最小授权确认页；完整桌面应用尚未交付。新计划拆为 P6-G0–G7，从技术／契约、外壳、角色、原 ZCode 桌面会话锚定推进到知识、收件箱和安装验收，见 [桌面实施计划](docs/DESKTOP_GUI_PLAN.md)。不自建聊天 Harness；正式发布和采纳仍由有权角色完成。下一开工入口为 [P6-G0](prompts/06G0-contract-and-spike.md)。

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

P5-H 初期的受限诊断已由 B0–B5-4 后续独立验收收口。受管 ZCode 适配器的材料载入、隔离请求、预算与结果链已有真实证据；非受管路径仍 restricted。详见 [ZCode 接入说明](docs/zcode-integration.md)与 [B5-4 独立验收](docs/phase-reports/P5-H-b5-4-review.md)。真正桌面原会话接入、点击流与安装包仍需按 P6-G 验证。
