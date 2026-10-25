# ADR-0011:真人授权入口预留为内部受信接口,GUI 确认面提前

日期:2026-10-24;状态:已接受(P5-H 增量 B0+B1 实施)。

## 背景

P5-H 复审(见 P5-H-review.md)确认 G01-Z01 阻塞于真人来源:ZCode 程序发送被宿主标记为 realUser/real_user 但 client_id 为 legacy-session-send,聊天内标签不可作授权凭据。同时现有阶段门规定 P6-G(GUI)前置 P5-H 通过,而 G01-Z01 的可信关闭手段恰是 GUI 确认入口——存在先后矛盾。所有者于 2026-10-24 决策:GUI 确认面提前,真人授权入口先以内部功能接口预留。

## 决策

1. **真人授权入口是内部受信接口,不是宿主聊天功能**。受信写入面(owner 凭据代码,即 CLI 控制台或 GUI 确认按钮)经 owner 专用操作 `authorizations.submitHumanEvent` 写入结构化事件记录(Schema `human-authorization-event`,含 entry 渠道 `cli-console` | `gui-confirm` 与 recorded_at),存储于工作空间状态层。适配器 `readHumanAuthorization` 端口从该存储读取并校验事实(workspace/subject/host/ref 四字段一致)。ZCode 聊天消息、宿主标签、模型转述永不形成授权事件。
2. **entry 枚举即受信入口注册表**。`cli-console`(B2 交付,首个可运行写入面,提供非 GUI 真实证据)、`gui-confirm`(G-min 交付)。新增入口须先修订协议。
3. **G-min(GUI 最小授权确认面)自 P6-G 提前**,作为独立子阶段插在 P5-H 增量 B3 与 B4 之间:仅"授权请求列表 → 确认/拒绝"入口,复用 owner 凭据与 ServiceClient,调用 `authorizations.submitHumanEvent`;桌面容器/IPC 基线在该子阶段技术验证。G01-Z01 由 G-min 证据 + P5-H 复审共同关闭;P6-G 整体(五页面)仍在 P5-H 收口之后。
4. **能力声明翻转条件**:`external.human_authorization_events` 仅在受信写入面产生真实事件记录并通过 recordHuman 全链验证 + 独立验收后置 true;此前保持 false,核心按 ADAPTER_CAPABILITY_MISSING 拒绝,owner-selection 降级路径(spec external-session-anchor.md)保持不变。
5. **威胁边界不变**(ADR-0009):能读取同一操作系统用户全部文件/内存的恶意本地代码不在防御范围内;entry 元数据标识受信渠道,不声称密码学级"真人在场"证明。

## 影响

- 阶段门修订:AGENTS.md 方向段、DESKTOP_GUI_PLAN.md §8、prompts/README.md 续作表插入 G-min 与 P5-H 增量(B0–B4)。
- 连接器工具面不包含授权事件读取——真人事件走工作空间存储,不走 ZCode 连接器(docs/zcode-connector-tools.md §4 明确)。
- B2 交付:事件存储表 + 迁移、`authorizations.submitHumanEvent` 服务实现、CLI 所有者写入命令、ZCodeAdapter `HumanAuthorizationSource` 内部接口。
- 锚定状态机、CAS 激活、授权撤销传播不受影响(anchor.ts 无需改动)。
