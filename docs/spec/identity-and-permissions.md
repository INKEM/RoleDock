# 规范：角色身份、权限与事务边界

协议版本：0.1
状态：P0 已固化（待独立验收）

## 1. 角色身份与会话分离

- 角色身份来自**受信会话绑定**：协调器在创建会话时把"该会话代表哪个角色的哪个实例"写入受信状态（Session 记录），后续调用的身份以绑定为准。
- 客户端在请求参数里自报的 `role_id` **不能自行取得角色权限**；SDK 操作若需要角色身份，从会话绑定解析，参数中的角色字段仅用于表达目标或声明，用于授权的一律忽略。
- 一个宿主会话至多绑定一个角色身份；请求分支绑定接收事务固定的目标角色与知识快照，不任职主实例，只取得受限的读取／提案作用域。发起者身份单独记录在请求中。
- 角色包中的角色名称（无论叫什么）不参与框架的权限与路由判断；核心代码不存在业务角色枚举，该约束由一致性测试持续检查。

## 2. 能力声明不是授权

- 角色包的 `requested_capabilities` 是**权限需求声明**，不是授权凭据；安装角色包本身不授予权限。
- 实际权限由工作空间所有者的策略决定：策略可以把声明映射为授权，也可以收紧或拒绝；授权结果随安装/升级记录，可审计。
- 发布权除策略授权外，还必须同时满足：文档所有权（发布者是该 `document_key` 的所有者角色）、当前主实例身份（发布者绑定的实例 = RoleHead 的 current_instance）、代次有效（generation 未被 retire）和基线版本（`expected_revision` 匹配）。
- 任何入口（SDK、CLI、MCP、适配器）共享同一核心权限与状态校验，不存在绕过检查的传输入口。

## 3. 权限校验模型

P1 起的两个入口（实现于 `@roledock/core`）：

- **所有者管理入口**（`WorkspaceAdmin`，CLI `admin policy/grant/revoke`）：本地可信面，唯一能把能力写入授权（workspace.config_json.policy.grants）的地方。安装角色包永不写授权。
- **会话调用入口**（`Coordinator`）：操作者必须持有受信会话身份（P3 起由 sessions.open 签发落库）；输入中的 role_id 只是目标或声明，不参与授权。

P0 固化校验顺序（实现于 P1+）：

1. 解析调用身份（会话绑定 → 实例 → 角色与代次）；
2. 解析目标对象与工作空间策略；
3. 校验策略授权（含 `requested_capabilities` 的授权映射）；
4. 校验对象级前置（所有权、代次、修订版本、状态机允许的转换）；
5. 事务内执行。

失败返回 `PERMISSION_DENIED`（策略）或对应的对象级错误码（`GENERATION_CONFLICT`、`REVISION_CONFLICT`、`INVALID_STATE_TRANSITION` 等）；错误响应不得泄漏调用者无权看到的对象信息。

P5-R 的实际动作权限如下；每次动作读取当前 grants，撤权立即生效，不从 requested 自动授予。对象级检查仍然执行。

| 动作 | 所需策略权限 |
| --- | --- |
| 文档 list/read；继承 prepare/activate | `documents.read` |
| 文档 publish / propose | `documents.publish` / `documents.propose` |
| 请求 create / execute | 发起者 `requests.create`；目标 `requests.execute` 与 `documents.read` |
| 请求 get / reply / cancel | 调用者 `requests.read` / `requests.reply` / `requests.cancel` |
| 产物 read | `artifacts.read` |

接收时把目标当时已授权的 `documents.read`／`documents.propose` 子集固定并传给宿主。分支的 list/read/propose 只可访问接收快照中的目标文档和修订，不能借默认“最新”读到后来更新；明确提案基线不得超出快照。分支始终无正式发布和嵌套请求权。

`Coordinator` 根入口不导出存储、低层任职或回执签发函数；`@roledock/core/testing` 是本地所有者测试夹具，不得暴露为会话工具。直接执行任意本地代码的所有者仍可管理文件和数据库；本阶段不宣称实现远程会话身份认证，显式锚定留待 P5-A。见 ADR-0008。

## 4. 事务边界

**原子完成**（单数据库事务，要么全部生效要么全部回滚）：

- 角色安装（角色、文档模板、能力声明的注册）
- 文档发布（新 DocumentRevision + knowledge_revision 递增）
- 交接激活（RoleHead 比较并交换 + 旧实例撤权）
- 请求接收（请求记录 + 代次/快照绑定）
- 请求终态转换（状态 + 结果/错误 + terminal_at）

**外部动作走待投递记录**（outbox，不进数据库事务）：

- 宿主会话创建与载入（交接 provision、请求执行分支创建）
- 结果读取与回收
- 知识导出导入的传输

规则：事务内写入"意图 + 创建键"，外部动作完成后在后续事务回填结果；协调器重启后依据创建键与适配器的 `lookupSessionByCreationKey` 对账；对账不明的标记 `execution_uncertain`，不盲目重试。

## 5. 隔离作用域

每个协作请求至少拥有独立的：

1. **上下文**：独立宿主会话，不与主会话共享对话历史；
2. **临时写入**：请求私有的临时文件/工作区；
3. **结果**：独立的 ArtifactRef，主会话通过收件箱归并，而非直接注入；
4. **能力作用域**：请求分支只持有任务所需的授权子集。

主会话不接受咨询请求的消息注入；归并候选进入收件箱，在正常主会话工作轮次读取。执行隔离不足的宿主必须返回受限等级，对要求隔离的任务显式拒绝（`ADAPTER_CAPABILITY_MISSING`），不得标注为完整接入。

## 6. 不可迁移知识

权限、密钥、活跃进程句柄和模型隐藏状态**不属于可迁移知识**，不得进入 Checkpoint、BootstrapBundle 或导出材料；交接与导出只携带可分享的语义知识（文档快照、交接摘要、决策引用、待办与来源）。

## P5-A 增量契约（2026-10-14）

授权、已有外部会话登记、sessions.anchor/binding/reconcile/release、共享连接身份和任务撤销规则见 [external-session-anchor.md](external-session-anchor.md) 与 [ADR-0009](../adr/0009-trusted-connections-and-anchor.md)。本增量的18项既有受信本地SDK操作保持；新增普通会话连接面不接受自报调用身份，普通Agent无所有者入口。RoleHead释放后允许current_instance_id=null，generation保持单调；新请求要求可服务主实例。Mock与MCP进程证据不替代P5-H真实宿主。
