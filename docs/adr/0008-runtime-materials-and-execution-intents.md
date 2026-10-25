# ADR-0008：固定材料载入与持久执行意图

- 状态：P5-R 实施，待独立验收
- 日期：2026-10-13
- 关联：ADR-0002/0003/0004、复验 R02–R14

## 决策

生产包只公开 Coordinator、WorkspaceAdmin、声明式包加载和类型／能力纯函数。原存储、任职捷径、回执签发、低层变更函数移至显式 testing 入口；它是所有者测试夹具，禁止注册为会话工具。Coordinator 用 ECMAScript 私有字段持有数据库。SDK 与 CLI 目前仍是受信本地控制器，传入会话 ID 不等于未来外部连接认证；受信连接隔离属于 P5-A。

每个文档动作在底层服务读取实时策略；对象守卫继续独立执行。请求接收固定契约正文、共享文档正文／来源和能力上限，执行再次核对发起者与目标策略及四项隔离。请求分支只传递 documents.read/propose 与策略的交集，无发布能力；分支读取限于接收快照。

BootstrapBundle 在元数据之外携带结构化材料：固定角色定义、指令、模板、Schema 引用闭包、共享文档正文／来源及 checkpoint。完整 payload 内容寻址持久化后才调用宿主；宿主验证完整哈希后确认。首次打开也先持久意图和材料、确认宿主载入后 CAS 初始化主指针。旧的缺正文请求不伪造载入，要求重新接收；旧 bundle 若没有持久正文，返回 NOT_IMPLEMENTED。

CheckpointBuilder 未指定 summary/todos/decisions/sources 时保留最近已提交内容。只读快照不增知识修订；明确改变这些已提交知识时与 checkpoint 同事务增修订。交接只载入 role/project/public 文档；独立请求只载入 project/public 文档，不包含主会话聊天。

请求执行阶段持久化 creating → turn-intent → result → waiting/done。同协调器的重叠投递共享一次执行，事务内领取 running。轮次键及预算预留在 runTurn 前落库；宿主按键去重并在 getResult 返回执行键。断线后只查询原轮次，无法确认时公开 execution_uncertain，不盲目再支出。运行中结果不能完成；明确完成且可读的正文才可成为内容寻址 artifact。结果、收件箱与终态同事务提交，所有异步返回后再次读取终态、期限与策略。

终态执行 close 并回收临时目录；cleanup_pending 持久化，重复投递可重试回收。取消阻止后续轮次；取消前已开始的外部轮次允许返回，但核心拒收迟到结果。Fixture cancel 标记由 turn 消费，不能只写无效果标记。

## 后果

公开请求创建只接收并写 outbox。参考 demo 的内部执行引擎由受信本地所有者 driver 投递，不是会话可调用工具；本阶段未交付生产常驻 outbox 消费服务，后续共享协调服务再建立受信消费面。

用户逻辑打开键持久化为 open_key，宿主创建键由核心为每个 provisioning 实例独立生成，避免用户输入与 request-${id} 别名冲突。知识漂移重新准备时保留逻辑键、换内部宿主键；原生恢复也使用记录的实际宿主键。

适配器新增可选载体字段：create 的 capability_scope/temp_dir、turn 的 execution_key/budget、result 的 completed/body/execution_key；独立请求要正式完成必须提供它们。缺失字段不产生假 artifact。固定回答夹具仍只证明协议和进程边界，G01 真实 Harness 缺口不变。旧调用方需要显式所有者授权；声明的 requested_capabilities 不自动映射为 grants。
