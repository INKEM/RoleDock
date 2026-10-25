# ADR-0010：ZCode 受限接入与未证实能力

日期：2026-10-14；状态：已实施受限诊断；[独立验收](../phase-reports/P5-H-review.md)确认本地边界通过，P5-H真实闭环BLOCKED。

## 决策

用户指定 ZCode 作为真实外部 Harness。实际环境分别固定 Desktop 3.15.3、bundled CLI 0.16.9、bundled runtime 元数据 0.13.3；使用已有 zcode-delegation 0.1.0 连接器，不以 `/usr/bin/zcode` 桌面入口猜测 CLI 参数。RoleDock 不读模型凭据，不直接调用模型 API。

连接器目前只证实会话创建、任务发送和结果读取。新增 `adapters/zcode` 提供可运行的受限适配器和诊断入口，通过显式配置的 MCP 连接器执行真实模型探针。未证实材料确认、能力范围及临时写入隔离，不能将提示词限制当作权限保证。因此 bootstrap、capability_scope、temp_dir 输入在宿主调用前以 NOT_IMPLEMENTED 拒绝；完整请求在核心隔离门禁拒绝。普通角色不能通过成功的诊断会话获得任职。

不声明已有会话身份、人类授权事件、材料载入或载入对账能力；不声明 cancel/nativeResume/nativeFork。关闭 MCP 进程不等于宿主会话关闭或模型取消，closeSession 明确 NOT_IMPLEMENTED。诊断连接器的进程清理单独描述，不记为宿主回收成功。

诊断创建及发送在宿主动作前保存本地 intent。未知创建/发送不自动重试；已确认映射可恢复，但宿主没有创建幂等键的窗口继续标记 uncertain。发送结果仅采用已确认接受的单个受控轮次、发送前序号之后连续完整的事件和实际终态正文；事件缺口、截断、多个轮次或旧结果不成为完成证据。能力仍标为 restricted，本地 execution_key 不能冒充宿主幂等支持。

## 保留门槛

UserPromptSubmit 同样由程序 session/send 触发，不能证明真人。Hook additionalContext 还可能截断且存在锚定工具等待载入的时序问题。主会话和分支的工具限制覆盖 MCP、插件和嵌套工具尚未证明；既有桌面会话的受支持实时接入接口亦未证实。

真实诊断答案只证明模型连通性及连接器部分行为。P5-H 和 G01 必须保持未通过，直到人类来源、完整材料确认、请求隔离和副作用对账均有实际证据。未交付真实角色闭环时不创建空的 full/harness-reference 包，不进入 GUI 或发布。
