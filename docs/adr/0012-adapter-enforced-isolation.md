# ADR-0012:四项隔离改由适配器强制(RoleDock 自有执行边界)

日期:2026-10-24;状态:已接受(实施随 P5-H 增量 B5,见 `docs/ADAPTER_SANDBOX_PLAN.md`)。

## 背景

P5-H 增量 B0–B4 与 G-min 独立验收后(见 `P5-H-b1…b4-review.md`、`P6-G-min-review.md`),G01 四门槛中 Z01/Z02/Z04 证据完备,仅剩 Z03(四项隔离)BLOCKED:ZCode 平台侧无受支持的会话级工具范围/嵌套 Agent 隔离机制;plan 模式与权限流只是部分证据(B4 实验在 permission 阶段前中止),四项声明保持 false,独立请求与收件箱采纳被核心门禁如实拒绝。所有者 2026-10-24 决策:不等待宿主官方机制,隔离改由 RoleDock 自身执行边界强制。

## 决策

1. **isolation.* 声明语义变更:由"宿主强制"改为"适配器保证"**。布尔为 true 表示适配器对该会话的效果边界负责;验收标准是逃逸测试证据(越界写/读被拦截、非白名单网络被拦截、嵌套 Agent 与插件 MCP 全部继承边界),不是宿主特性文档或权限模式声明。
2. **强制机制在效果层,不在调用层**。被隔离的咨询分支宿主进程跑在 RoleDock 启动的 OS 沙箱内(受限文件系统、白名单可写目录、出口白名单模型端点、pid/cgroup 边界覆盖全部子进程)。模型可调用任意工具,效果够不着边界外即达标;不做逐工具白名单,`capability_scope` 的每请求收窄仍属 RoleDock 策略语义(材料内容与授权),不声明宿主工具级隔离。
3. **受管执行模式(managed execution)**。仅独立请求的咨询分支需要沙箱;主锚定会话仍在用户桌面 app(owner 授权的用户对话,非委托执行),不沙箱。适配器能力面新增受管执行声明;conformance 套件以受管变体统一测隔离,消解 zcode 因 restricted 不满足全能力工厂语义进不了 `defineAdapterContractSuite` 的问题。
4. **失败关闭**。检测不到可用沙箱 runner、启动失败或发现逃逸时,如实 NOT_IMPLEMENTED/uncertain 并保持声明 false,不降级为无沙箱执行而仍声明隔离。首版 Linux 本地;Windows/macOS 在实际验证前不支持。
5. **凭据与网络**。沙箱内不携带 owner 凭据与宿主账户存储;模型 API 头经连接器 RPC 按需注入(沿用 B3 机制);出口白名单仅放行模型 provider 端点,配置化不硬编码。沙箱启动失败/逃逸一律 uncertain,不假成功。
6. **威胁边界**。沙箱目标是约束模型/会话的执行效果;ADR-0009 中同机同用户全权恶意代码仍不在防御范围,内核逃逸不属于本决策防御目标。
7. **收口条件**。05H 第七、八步(独立请求×10 重叠 + 收件箱采纳)在受管变体上真实复验通过并经独立验收后,G01-Z03 关闭、四项声明翻转;声明翻转此前保持 false。

## 影响

- 新增计划文档 `docs/ADAPTER_SANDBOX_PLAN.md`(P5-H 增量 B5 系列,沿用一次一个独立验收,报告 `P5-H-b5N-development.md`)。
- `docs/spec/adapter-contract.md` 增加"受管执行与隔离证据"语义;`docs/zcode-connector-tools.md` 增加 §4.5 受管执行草案。
- 阶段门文档:AGENTS.md 方向段、DESKTOP_GUI_PLAN.md §8、prompts/README.md 续作表插入 B5 行。
- B0–B4/G-min 已验收范围不变;真人事件、身份验证、载入对账、cancel/close/预算路径全部复用。
- 既有契约钩子就位:`CreateSessionInput.capability_scope`/`temp_dir` 在受管路径下不再 NOT_IMPLEMENTED(沙箱白名单目录与语义记录),不再作为 zcode 适配器的永久拒绝项。
