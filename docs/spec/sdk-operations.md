# 规范：SDK 操作契约

协议版本：0.1
状态：P0 已固化（待独立验收）
代码面：`@roledock/core` 的 `Coordinator`（P0 仅定义操作面与失败契约）

每个操作按统一模板定义。**实现阶段**（P1–P5）必须按本表落地；在此之前任何方法被调用都必须抛出 `NOT_IMPLEMENTED`，不得伪装成功（P0 已用测试固化该行为）。

通用约定：

- **输入/输出**：输入输出都是 JSON 可序列化对象；输出一律为信封 `OutputEnvelope`（`{ok:true, data}`）或错误信封 `ErrorEnvelope`（`{ok:false, error:{code,message,...}}`）。SDK 方法层面以 `RoleDockError` 表达错误，边界层（CLI/协议绑定）负责转信封。
- **调用身份**：除非注明"无身份"，均来自会话绑定（见 `identity-and-permissions.md` §1）；客户端自报角色不用于授权。
- **原子性**：`A` = 单事务原子完成；`O` = 事务内落待投递记录，外部动作异步衔接（见 `identity-and-permissions.md` §4）。
- 这些操作不是 MCP、ACP 或 A2A 的原生方法；协议绑定层负责把 SDK 操作映射到对应协议的工具/资源/会话原语，不得混用标准能力字段。

## 1. roles

### roles.install
- 输入：角色包清单（`rolepack.schema.json`）+ 包内容（模板、Schema 文件）
- 输出：已安装包的 `role_contract`（名称、版本、内容哈希）与注册的角色清单
- 身份：工作空间所有者
- 前置：Schema 与语义校验通过；包路径不越界、无越界符号链接；角色 ID 无冲突（冲突显式拒绝）
- 错误：`VALIDATION_FAILED`、`ROLE_ALREADY_EXISTS`
- 幂等：同名同版本同哈希 → 幂等成功；不同内容 → 视为新版本，走显式升级
- 原子性：A

### roles.list
- 输入：工作空间过滤项
- 输出：角色 ID、标题、所属包、代次、knowledge_revision、能力授权摘要
- 身份：任意已绑定会话（只见可见范围内的信息）
- 错误：`PERMISSION_DENIED`
- 原子性：只读

### roles.resolve
- 输入：角色 ID
- 输出：该角色当前 RoleHead 摘要（代次、knowledge_revision、是否有主实例）
- 身份：任意已绑定会话
- 错误：`NOT_FOUND`、`ROLE_UNINITIALIZED`（无主实例时以状态字段表达）
- 原子性：只读

## 2. sessions（P3 交付）

### sessions.open
- 输入：角色 ID、`inherit:"latest"`（已初始化角色必填）、创建键（幂等）、适配器注入
- 输出：会话 ID、实例 ID、代次、前任实例、交接信息（bundle_id/checkpoint_id/reprepared）
- 身份：工作空间用户（产生新的受信绑定）
- 语义：未初始化角色自动初始化第 1 代；已初始化角色执行 prepare→provision→activate 完整交接；准备期知识漂移自动重准备（上限 3 次）；指针被并发移动 → `GENERATION_CONFLICT` 不重准备
- 错误：`NOT_FOUND`、`VALIDATION_FAILED`、`GENERATION_CONFLICT`、`REVISION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`ADAPTER_CAPABILITY_MISSING`
- 幂等：创建键同键同内容 → 返回原会话；同键不确定态 → 按创建键对账恢复，不盲目新建
- 原子性：A（绑定与指针切换）+ O（宿主会话创建）

### sessions.resume
- 输入：已有会话 ID
- 输出：{resumed, method:"native"|null, generation, alternative?}
- 语义：仅适配器声明 `nativeResume` 时原生恢复；适配器不持有宿主时如实 `resumed:false` 并指向语义继承；**永不加代次、不动主指针**
- 错误：`NOT_FOUND`
- 原子性：只读 + 适配器协商

## 3. documents

### documents.list
- 输入：角色/可见性过滤
- 输出：调用者可见的文档键、最新修订、可见性
- 身份：会话绑定（可见性过滤强制）
- 原子性：只读

### documents.read
- 输入：角色 ID + 文档键（+ 可选修订号，缺省最新）
- 输出：正文与 DocumentRevision 元数据；读取写入调用者会话的读取记录（供请求前置使用）
- 身份：会话绑定
- 前置：可见性允许调用者读取
- 错误：`NOT_FOUND`、`PERMISSION_DENIED`
- 原子性：只读（读取记录追加为 A）

### documents.propose
- 输入：目标文档（所有者角色 + 键）、候选正文、基线修订、提案说明
- 输出：CandidateUpdate 标识
- 身份：发起会话绑定（非所有者提出候选）
- 前置：目标文档对提案者可见
- 错误：`NOT_FOUND`、`PERMISSION_DENIED`、`REVISION_CONFLICT`（基线过期）
- 原子性：A

### documents.publish
- 输入：所有者角色 + 文档键 + 新正文 + `expected_revision`
- 输出：新 DocumentRevision（修订号、内容哈希）与新 knowledge_revision
- 身份：所有者角色当前主实例（旧代次拒绝）
- 前置：所有权 + 主实例 + 代次有效 + `expected_revision` 匹配
- 错误：`PERMISSION_DENIED`、`INVALID_STATE_TRANSITION`（旧代次）、`REVISION_CONFLICT`
- 原子性：A（发布 + knowledge_revision 递增同一事务）

## 4. handoffs（P3 交付）

### handoffs.prepare
- 输入：当前主实例会话 ID（+ 可选角色 ID，缺省取绑定角色）
- 输出：bundle_id、source_generation、source_knowledge_revision、checkpoint_id、bundle payload 及其哈希
- 身份：当前主实例会话（咨询分支与旧代次拒绝）
- 语义：固化 checkpoint（文档快照）与角色包契约三元组；不改主指针
- 错误：`ROLE_UNINITIALIZED`、`INVALID_STATE_TRANSITION`、`VALIDATION_FAILED`
- 原子性：A（Checkpoint/bundle 落库）

### handoffs.activate
- 输入：bundle_id（bundle 尚未 provision 时由协调器适配器按需 provision）
- 输出：新会话/实例 ID、generation、predecessor_instance_id
- 前置：比较并交换——generation 与 knowledge_revision 仍等于 bundle 来源值；并发仅一个成功
- 错误：`GENERATION_CONFLICT`、`REVISION_CONFLICT`、`INVALID_STATE_TRANSITION`、`NOT_FOUND`、`ADAPTER_CAPABILITY_MISSING`
- 原子性：A（指针切换 + 旧实例 superseded）；宿主创建为 O

## 5. requests（P4 交付）

### requests.create
- 输入：目标角色 ID、问题正文、幂等键、预算（max_turns/max_output_bytes/deadline）、读取例外理由（可省）
- 输出：CollaborationRequest（接收事务内固定的 binding：实例/代次/知识修订/可分享快照/契约版本）
- 身份：发起主会话绑定；consultation 分支发起 → `PERMISSION_DENIED`（原型拒绝嵌套）
- 前置：目标已安装且有主实例（否则 `ROLE_UNINITIALIZED`）；会话真实回执或例外理由齐备；deadline 在未来
- 错误：`ROLE_UNINITIALIZED`、`VALIDATION_FAILED`、`IDEMPOTENCY_CONFLICT`、`PERMISSION_DENIED`
- 幂等：同键同内容 → 原请求；异内容 → 冲突
- 原子性：A（接收与绑定 + outbox 待执行事件）+ O（consultation 分支创建，创建键对账）

### requests.get
- 输入：请求 ID
- 输出：请求当前状态机快照（含预算与结果引用）
- 身份：仅发起方或目标角色主实例；跨身份 `PERMISSION_DENIED`
- 惰性到期：deadline 已过 → 转 expired
- 错误：`NOT_FOUND`、`PERMISSION_DENIED`
- 原子性：只读

### requests.reply
- 输入：请求 ID + 回复正文
- 输出：更新后的请求（回 queued 并重执行一轮预算内轮次）
- 身份：仅发起者；跨身份 `PERMISSION_DENIED`
- 错误：`INVALID_STATE_TRANSITION`（非 awaiting_input）、`NOT_FOUND`、`PERMISSION_DENIED`
- 原子性：A + O

### requests.cancel
- 输入：请求 ID
- 输出：终态请求记录
- 身份：仅发起者
- 语义：accepted/queued/awaiting_input 直接取消；running 需适配器 `cancel` 能力（协商）；已终态 → `REQUEST_NOT_TERMINABLE`
- 错误：`REQUEST_NOT_TERMINABLE`、`NOT_FOUND`、`PERMISSION_DENIED`
- 原子性：A；运行中协商为 O

## 6. artifacts（P4 交付）

### artifacts.read
- 输入：artifact_id
- 输出：产物内容（内容寻址读取，读取时哈希校验）与元数据
- 身份：请求发起者或目标角色主实例；跨身份 `PERMISSION_DENIED`
- 错误：`NOT_FOUND`、`PERMISSION_DENIED`
- 原子性：只读

## 7. knowledge

### knowledge.export
- 输入：角色 ID、导出范围
- 输出：可迁移知识材料（文档快照、Checkpoint、bundle；哈希校验）
- 身份：角色主实例或工作空间所有者
- 约束：材料不含凭据、私人聊天、活跃工具句柄与模型隐藏状态
- 原子性：O

### knowledge.import
- 输入：导出材料 + 目标工作空间
- 输出：导入清单与内容哈希核对结果
- 身份：工作空间所有者
- 前置：协议版本兼容（`protocol_version`）
- 错误：`VALIDATION_FAILED`、`ROLE_ALREADY_EXISTS`（冲突时显式改名或拒绝）
- 原子性：A（落库）；不复制私密聊天或模型隐藏状态

## 8. 错误码总表

| 错误码 | 触发条件 |
| --- | --- |
| `NOT_IMPLEMENTED` | 操作已规范但未实现（本构建） |
| `VALIDATION_FAILED` | 输入未通过 Schema/语义校验 |
| `NOT_FOUND` | 引用对象不存在 |
| `PERMISSION_DENIED` | 受信身份在策略下缺少所需权限 |
| `ROLE_ALREADY_EXISTS` | 安装时角色 ID 冲突，需显式处理 |
| `ROLE_UNINITIALIZED` | 目标角色无主实例 |
| `GENERATION_CONFLICT` | 交接比较并交换失败，指针已被并发移动 |
| `REVISION_CONFLICT` | 发布基线过期（expected_revision 不匹配）或准备期知识漂移 |
| `INVALID_STATE_TRANSITION` | 状态机不允许的转换（旧代次发布、终态复活等） |
| `IDEMPOTENCY_CONFLICT` | 同幂等键不同内容 |
| `REQUEST_NOT_TERMINABLE` | 请求当前状态不可取消 |
| `ADAPTER_CAPABILITY_MISSING` | 适配器缺少必需能力，返回受限等级 |
| `WORKSPACE_LOCKED` | 另一协调器进程持有工作空间写锁（ADR-0001：单协调器写入） |
| `INTERNAL` | 未预期的内部失败，必须报告不得伪装为领域结果 |

错误码注册表代码侧唯一来源：`@roledock/protocol` 的 `ERROR_CODES`；Schema 侧枚举必须与之完全一致（一致性测试保证）。
