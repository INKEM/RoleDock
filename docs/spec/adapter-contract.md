# 规范：Harness 适配契约

协议版本：0.1
状态：P0 已固化（待独立验收）
实现载体：`adapters/`（目录约定，P5 交付 mock / process-bridge / harness-reference）

## 1. HarnessAdapter 接口

适配器把 RoleDock 核心与具体宿主（Harness）连接起来。核心不直接调用任何模型 API。

**必选方法**（缺失即不构成适配器）：

| 方法 | 语义 |
| --- | --- |
| `getCapabilities` | 返回能力清单与受限等级声明 |
| `createSession(input)` | 新建宿主会话；`input.creation_key` 用于幂等创建与重启对账 |
| `runTurn(session, turn)` | 执行一轮任务 |
| `getResult(session)` | 读取结果与状态 |
| `closeSession(session)` | 关闭并回收 |

**协商能力**（声明后才可使用；未声明时核心不得调用）：

| 能力 | 语义 |
| --- | --- |
| `cancel` | 取消进行中的执行 |
| `lookupSessionByCreationKey` | 按创建键查询宿主会话（execution_uncertain 对账的依据） |
| `nativeResume` | 宿主原生恢复会话上下文 |
| `nativeFork` | 宿主原生复制会话上下文 |

## 2. 能力等级

适配器必须声明能力等级，核心据此决定可用路径：

- **完整接入**：上下文、临时写入、结果与能力作用域四项隔离均可在该宿主保证。
- **受限等级**：任一隔离项无法保证。受限等级下，需要隔离的任务必须显式拒绝（`ADAPTER_CAPABILITY_MISSING`），不得把不具备上下文隔离的宿主标为完整接入。

自 ADR-0012（2026-10-24）起，"保证"的语义从"宿主强制"修订为"适配器保证"：四项隔离可以由适配器自有执行边界（受管沙箱）负责，验收标准是逃逸测试证据而非宿主特性文档，详见文末"P5-H 增量 B5：受管执行与隔离证据"。

## 3. 通用分支路径

**通用分支路径**是：新建宿主会话并载入可分享角色知识（BootstrapBundle）。它不依赖宿主原生能力，是跨 Harness 的基础依赖。

原生 fork 只在能力受支持**且**上下文分享范围可证明时使用，作为体验优化；会话恢复（nativeResume）同理。二者不进入正确性关键路径：Mock 与参考适配器永远可用通用路径完成交接与请求。

**已有会话接入**需要宿主提供启动钩子或 wrapper，在首个工作轮次前执行角色载入。仅连接 MCP 工具不会自动接管任意宿主的会话创建——这一点写入适配器文档，避免错误预期。

## 4. 适配验证三层

| 层 | 对象 | 有效性 |
| --- | --- | --- |
| Mock | 状态机、故障注入、并发 | 验证核心状态行为；不是真实宿主证据 |
| 进程桥接 | 真实子进程、操作系统执行、消息边界 | 验证桥接与边界；固定回答程序可作为夹具 |
| 真实 Harness | 角色载入、上下文隔离、端到端 | 唯一可证明"真实接入"的层 |

规则：Mock 与固定回答夹具的通过记录**不得**被写成真实 Harness 验证证据；真实 Harness 测试单独标记，跳过不算通过。

## 5. Mock 参考实现（P3 交付）

`@roledock/adapter-mock`（`adapters/mock/`）：内存宿主，可配置能力声明与故障注入（创建硬失败 / 创建后不确定、前 N 次不确定），记录宿主会话 transcript 与已载入 bundle，createSession 校验 bundle 内容哈希；nativeFork 拒绝跨角色全量私人历史。P3 的全部交接状态测试以它运行——**这些测试只证明核心状态机制，不构成真实宿主验证**。

## 6. 术语映射

交接指针冲突在阶段提示词中曾称 HEAD_CONFLICT；协议错误码注册表（P0 固化）定名 **`GENERATION_CONFLICT`**，两者同义，规范与实现统一使用后者。

## 7. P5-R 材料、轮次与回收

`createSession` 的 bootstrap payload 含固定角色定义、指令、模板与本地 Schema 引用闭包，以及授权的知识正文和来源。首代和请求使用各自材料结构；继承使用可通过协议 Schema 校验的 BootstrapBundle.materials。宿主重算 payload 哈希并在创建成功前确认载入，不能以只有 ID／哈希的引用冒充正文已送达。旧持久化记录没有材料时返回 NOT_IMPLEMENTED，需重新准备。

请求创建同时传 `capability_scope` 和 `temp_dir`；作用域只含接收时授权的文档读取／提案子集。`runTurn` 接收稳定 `execution_key` 和预算，同键不得重复花费轮次。核心先持久化预留；失去确认后仅查询。`getResult` 返回 `state`、`turn_count`、`execution_key`、`completed`、`body`、`output_bytes`、`needs_input`。只有明确完成、有匹配键及可读正文才能提交产物；输出字节取实际 UTF-8 字节和宿主报告的较大值。

声明 cancel 的适配器必须阻止取消后的新轮次；已经运行的轮次可以迟到返回，由核心终态守卫拒收。close 必须可重复调用。核心持久化终态回收标记，失败在后续投递重试。Mock 与固定回答 bridge 在此仅证明协议和状态行为。

## P5-A 增量契约（2026-10-14）

授权、已有外部会话登记、sessions.anchor/binding/reconcile/release、共享连接身份和任务撤销规则见 [external-session-anchor.md](external-session-anchor.md) 与 [ADR-0009](../adr/0009-trusted-connections-and-anchor.md)。本增量的18项既有受信本地SDK操作保持；新增普通会话连接面不接受自报调用身份，普通Agent无所有者入口。RoleHead释放后允许current_instance_id=null，generation保持单调；新请求要求可服务主实例。Mock与MCP进程证据不替代P5-H真实宿主。

## P5-H 增量 B5：受管执行与隔离证据（ADR-0012，2026-10-24）

四项隔离（`isolation.context` / `temp_writes` / `results` / `capability_scope`）的声明语义自本增量起从"宿主强制"修订为"**适配器保证**"：布尔为 true 表示适配器对该会话的效果边界负责，被隔离的咨询分支宿主进程运行在适配器启动的 OS 沙箱（受管执行）内。

**验收标准是逃逸测试证据，不是宿主特性文档或权限模式声明。** 声明翻转前必须具备：越界写/读被拦截、非白名单网络被拦截、pid/cgroup 边界覆盖全部子进程（嵌套 Agent、插件 MCP、孙进程）、runner 缺失/启动失败/发现逃逸时如实 `NOT_IMPLEMENTED` 或 uncertain 的失败关闭证据；矩阵与退出条件见 [ADAPTER_SANDBOX_PLAN](../ADAPTER_SANDBOX_PLAN.md) §3–§4（B5-2 逃逸证据集 + B5-3 全链证据，均经独立验收）。

规则：

1. **受管执行范围**：仅独立请求的咨询分支需要沙箱；主锚定会话运行在用户桌面 app（owner 授权的用户对话），不沙箱。
2. **强制在效果层，不在调用层**：模型可调用宿主任意工具，效果够不着边界外即达标；`capability_scope` 的每请求收窄仍属核心材料与策略语义，不声明宿主工具级隔离。
3. **失败关闭**：沙箱 runner 缺失、启动失败或中途消亡 → `NOT_IMPLEMENTED` 或 uncertain，绝不无沙箱降级运行而仍声明隔离；Windows/macOS 在实际验证前不支持。
4. **声明与证据分离（已于 B5-4 落地）**：B5-2 逃逸证据集与 B5-3 全链证据（10 重叠请求 + 收件箱采纳）均已独立验收 PASS；`isolation.*` 四项随**受管执行声明**翻转——受管变体声明 `level:"full"` + 四项 true，与运行时事实绑定（构造时 `managed:{egress}` + 逐实例 `zcode_sandbox_status` 验证，不符即 NOT_IMPLEMENTED 失败关闭）；非受管路径保持 restricted/false。受管变体已进入 `defineAdapterContractSuite`（`adapters/zcode/test/contract.test.ts`，协议一致性证据，非真实宿主证据）。
5. **既有路径不变**：B0–B4/G-min 已验收行为（真人事件、身份验证、载入对账、cancel/close/预算）全部复用，受管模式只新增执行边界；`CreateSessionInput.capability_scope`/`temp_dir` 在受管路径生效（B5-3 已交付：scope 冻结记录入 journal、temp_dir 位于工作空间 rw 白名单），不再是 zcode 适配器的非受管路径支持项——非受管构造仍拒绝二者。
6. **受管变体的声明与验证绑定**（B5-3）：managed 构造的 zcode 适配器声明 `level:"full"` + 四项隔离 true，且必须在首次受管 createSession 时经连接器 `zcode_sandbox_status` 工具验证沙箱与 egress 白名单匹配，不符即 NOT_IMPLEMENTED 失败关闭；非受管适配器的声明不受影响。
