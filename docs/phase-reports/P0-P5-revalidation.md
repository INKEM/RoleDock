# P0–P5 当前工作区独立复验

日期：2026-10-13  
验收方：Codex；两名独立审查 Agent 分别检查 P0–P2 和 P3–P5，主 Agent 执行门禁、汇总证据与结论  
依据：`AGENTS.md`、原开发蓝图、`prompts/COMMON.md`、`prompts/REVIEW.md`、P0–P5 提示词、四份规范与阶段开发报告  
范围：本地仓库源码、现有测试及临时工作空间的模拟数据；未访问外部测试目标，未使用真实凭据，未修改产品实现

## 1. 结论与基线

| 阶段 | 本轮结论 | 必须处理的事项 |
| --- | --- | --- |
| P0 | **PASS** | 契约、Schema、ADR、工具链与骨架条件满足；不代表后续运行时正确 |
| P1 | **REWORK** | R01：输出 Schema 引用闭包及文件类型校验不完整 |
| P2 | **REWORK** | R02–R06：实际策略授权、公开测试捷径／回执、提案基线、导入路径与知识版本 |
| P3 | **REWORK** | R07–R09：角色／知识未载入、摘要丢失、恢复空 payload、幂等代次与恢复结果 |
| P4 | **REWORK** | R02/R03、R10–R14：请求授权隔离、终态、预算、真实结果、恢复与重复执行 |
| P5 | **REWORK** | R07/R10–R15 影响桥接与演示闭环；另有 G01：真实 Harness **BLOCKED** 外部缺口 |

现有 **279/279 测试通过，0 跳过**，但专项反例证明若干必需条件未被测试覆盖。旧报告中的 PASS／“可交付部分全部合格”不作为当前基线的继续开发依据。新增 GUI 需求单独进入计划，不用新需求追溯否定旧阶段。

HEAD 为 `a083874e60e7a40d88a18e075b699b1fb818b0e1`。验收对象是该提交加本轮开始时已有的 P5 工作区：14 个 tracked 文件修改，以及 process-bridge、共享契约、演示和文档等未跟踪交付。P5 开发报告的“提交后干净”与实际不符；本轮未提交这些改动，保留用户工作区。

产品源码与配置的逐文件哈希保存在 [implementation-baseline.sha256](evidence/2026-10-13/implementation-baseline.sha256)，清单本身 SHA-256 为 `480ad08a1f78c2c6dd11b6fc9986764ba27a5d601e908dc97dc393aa5ba6bdd8`。测试构建生成的 dist 不作为独立源码基线。本轮修改仅为计划、验收文档及证据。

## 2. 实际执行与环境限制

| 命令／验证 | 本轮实际结果 | 证据 |
| --- | --- | --- |
| `source ~/.nvm/nvm.sh && nvm use` | Node 22.23.2，npm 10.9.8 | 工具执行输出；环境与 `.nvmrc` 一致 |
| `npm ci` | 成功，按锁文件安装 52 包 | [npm-ci.log](evidence/2026-10-13/npm-ci.log) |
| 沙箱内 `npm run check` | typecheck/build 成功；255 passed、24 failed；子进程 EPERM／输出管道异常，锁测试超时及 worker 回收超时 | [check-sandboxed.log](evidence/2026-10-13/check-sandboxed.log) |
| 沙箱外 `timeout 180s npm run check` | typecheck/build 成功；测试在 180 秒预算内未完成，退出 124；不计成功 | [check-unsandboxed-timeout.log](evidence/2026-10-13/check-unsandboxed-timeout.log) |
| 沙箱外 `timeout 480s npx vitest run --reporter=verbose` | **26 文件、279 测试全部通过，0 跳过，退出 0；192.76 秒** | [vitest-unsandboxed.log](evidence/2026-10-13/vitest-unsandboxed.log) |
| 当前构建产物专项复现 | 缺陷出现，脚本退出 0 表示复现执行完毕，不表示验收通过 | [证据说明](evidence/2026-10-13/README.md)及专项日志 |

沙箱外执行现有测试获得自动审批通过。沙箱异常不列为产品缺陷。此次 typecheck/build 与完整 vitest 分开取得成功证据，不伪称一个 `npm run check` 调用全部通过。共享适配器套件、真实进程锁与两遍 demo 集成测试都包含在最终 279 项成功结果中，fixture 通过仍不证明真实模型接入。

## 3. 原阶段验收条件逐项核验

### P0

| 原条件 | 文件／行为／测试 | 判定 |
| --- | --- | --- |
| 四个不同角色，无核心业务枚举 | rolepack Schema、valid-four-roles 夹具、rolepack/no-business-roles conformance | 满足 |
| 冲突、旧发布、接收时绑定、终态、不确定、可见性有定义 | `docs/spec/` 四份规范、对应 Schema 和 ADR-0001–0006 | 契约定义满足 |
| 构建、类型与 Schema 测试通过，环境完整 | 本轮 typecheck/build 和 protocol 全套测试；`.nvmrc`、锁文件、toolchain | 满足 |
| 声明不等于授权，不以骨架冒充运行时 | 规范明确定义；后续运行时的违反列入 R02/R10 | P0 范围满足 |

### P1

| 原条件 | 文件／行为／测试 | 判定 |
| --- | --- | --- |
| 两包安装查询、重启保持、冲突结构化 | roles/install、summary、store；install/examples-install 测试 | 正常与冲突路径满足 |
| 需求声明不自动写 grants | 安装事务不更新 policy；policy 测试、无 grants 专项 | 授权表基础满足，实际动作另见 P2/P4 |
| 跨空间、路径越界、错误迁移拒绝 | workspaceId、迁移 checksum、角色文件直接越界/symlink 测试 | 部分满足；引用闭包和目录被接受，R01 |
| 回滚不半安装，无业务角色依赖 | 安装事务／staging 清理和一致性测试 | 满足 |
| 真正锁级／进程验证 | EXCLUSIVE SQLite、workspace-lock.process，SIGKILL 后重开 | 本轮沙箱外集成测试满足 |

### P2

| 原条件 | 文件／行为／测试 | 判定 |
| --- | --- | --- |
| 历史可读，过期/非所有者/旧代次拒绝 | documents 测试和服务的所有权/CAS 校验 | 对象级满足；策略未检查 R02，公开捷径 R03 |
| 并发发布一胜、冲突候选保留 | documents 测试与事务 | 部分满足；提案旧基线被悄悄改写，R04 |
| 相关知识更新递增且快照固定版本 | 文档发布递增、checkpoint 快照 | 摘要更新未递增，R06 |
| 回执不可跨身份冒用，导入校验基线 | 读取路径的绑定、候选采用基线 | 正式包导出任意回执写入，R03；提案基线 R04 |
| 往返哈希与来源、默认私有过滤 | knowledge-transfer 正常 share 测试 | 正常路径满足；文件可逃出包目录，R05 |

### P3

| 原条件 | 文件／行为／测试 | 判定 |
| --- | --- | --- |
| 初开/后继代次、前任、知识引用 | open/handoff 测试和 CAS | 引用存在但材料未送达，首次无宿主；R07 |
| 并发只一激活，旧实例拒绝发布 | handoff 双 prepare、GENERATION_CONFLICT、旧实例检查 | CAS 正常路径满足；公开直升捷径 R03 |
| 知识变化重新准备，失败留旧主 | 文档漂移与宿主硬失败测试 | 文档路径满足；摘要丢失／不递增 R06/R07，恢复 R08 |
| consultation 非主，resume 不增代次 | sessions kind 与 resume 测试 | 不增代次满足；无宿主仍报 native 恢复成功，R09 |
| 不确定创建不盲目重试，可恢复 | provisioning 意图和 lookup 路径 | 恢复用空 payload 无法创建，R08；重放错误代次 R09 |
| Mock 覆盖要求且真实宿主缺口明确 | 既有 handoff/mock 测试与诚实能力声明 | 正常覆盖存在，专项暴露上述反例 |

### P4

| 原条件 | 文件／行为／测试 | 判定 |
| --- | --- | --- |
| 10 并发上下文/文件/结果/作用域隔离，无主消息注入 | request 独立目录、分支、主 transcript 测试 | 10 请求测试实际逐个执行，R14；受限宿主未拒绝 R10 |
| 与交接并发，旧快照保留，新请求新代次 | create 接收事务固定绑定；requests 测试 | 绑定机制满足；角色知识实际材料缺口 R07 |
| 幂等键同内容复用、异内容冲突，重复投递不重复结果 | create 幂等与状态测试 | 接收满足；重叠 execute 无领取事务，R14 |
| 取消/到期迟到拒收、不确定不重复副作用 | executor、service | 取消可复活、到期可完成 R11；预算 R12；恢复 R13 |
| 跨身份读取/回复/取消/采纳拒绝 | requireParticipant、对象权限矩阵 | 对象级矩阵满足；策略授权 R02/R10 和公开回执 R03 |
| 候选采纳检查代次/修订，旧分支无正式写权 | documents adopt_artifact、requests 测试 | 正常守卫满足；真实回答未进入产物 R12 |

### P5

| 原条件 | 文件／行为／测试 | 判定 |
| --- | --- | --- |
| mock/bridge 同一契约，能力降级明确 | adapter-suite 两实例化，本轮全绿 | 声明与测试正常；核心未执行隔离拒绝 R10，取消 R15 |
| 一个真实 Harness 角色载入/继承/独立请求 | 只有 fixture-host，无 harness-reference | G01 外部缺口；未完成 |
| CLI JSON 机器可读，无人工混入 | cli 和 cli.spawn 测试，本轮通过 | 满足 |
| 演示可重跑，不污染现有主会话，语义迁移 | demo 集成两遍通过；临时工作空间、share 导出 | 机械流程满足；角色知识、真实回答缺口 R07/R12 |
| 宿主/模型版本与产物来源日志，去凭据 | demo JSONL 显式 fixture/none、版本与引用 | 夹具日志满足；真实 Harness 日志待 G01 |

## 4. 返工项

优先级 `P1` 为阻止相应阶段通过的核心行为问题，`P2` 为必须修复的契约／边界问题；不把文件源码改为假成功以消除反例。每项位置均为本轮源码基线。

### R01 — P2：角色包引用校验不闭合（P1）

位置：`roles/loader.ts:44`、`:68`、`:163`。输出 Schema 的 `ftp://`、协议相对 URL、`file://`、`../outside.json` 以及本地下一层的 https 引用都被接受；模板可指向现存目录。证据：[loader.log](evidence/2026-10-13/loader.log)。影响是契约无法证明全部材料位于包内、必需模板有效；本轮没有执行这些外部引用，也没有实际泄漏。

修复：校验允许的 URI／fragment、完整本地引用闭包与常规文件类型，拒绝缺失、越界、远程及越界 symlink，循环引用安全终止。复验上述反例均 VALIDATION_FAILED，合法递归本地引用可加载。

### R02 — P1：工作空间策略未约束实际动作（P2，影响 P4）

位置：`documents/service.ts:283`及各文档动作；Coordinator 没有补偿检查。正式 sessions.open 后，granted=[] 时 publish 成功；grant→revoke 后仍发布下一修订。证据：[p0-p2.log](evidence/2026-10-13/p0-p2.log)。对象所有权／代次检查不能替代策略授权。

修复：统一策略检查进入所有实际动作和可达底层服务；撤权立即生效。复验无授权、撤权后的读写/提案/发布拒绝，零修订／候选／回执变化；授权后允许，保持对象级守卫。

### R03 — P1：正式入口暴露测试任职捷径与任意回执写入（P2，影响 P3/P4）

位置：`packages/core/src/index.ts:51`、`sessions/internal.ts:72`、`:158`。普通正式包可导入 WorkspaceStore 和 openPrimarySession，绕过交接流程直接升代；recordReadReceipt 能为不存在的文档／版本999生成回执，该会话随后不读文档、无例外也能创建请求。证据：[p0-p2.log](evidence/2026-10-13/p0-p2.log)、[knowledge-receipts.log](evidence/2026-10-13/knowledge-receipts.log)。旧报告“仅 core/testing 可达”的结论不符合包 exports。

修复：生产入口移除测试捷径和任意回执签发；审查存储／低层公开面的可信范围，会话工具不能接触它们；请求校验回执所指文档、版本、哈希与实际目标关联。复验生产包导入和公开调用无法铸造捷径／回执，正常读取仍产生有效回执。

### R04 — P2：提案悄悄重设编辑基线（P2）

位置：`coordinator.ts:266`、`documents/service.ts:569`。v2 已存在时传 baseline_revision=1 的提案被忽略，候选记录为 baseline=2。证据：[p0-p2.log](evidence/2026-10-13/p0-p2.log)。过时编辑被视为以新版为基础，与 sdk-operations 的基线冲突契约不符。

修复：接受并验证明确编辑基线；过期拒绝或保留原基线候选，不能自动抬升。复验 v1 编辑和 v2 发布交错，采纳冲突且原编辑内容保留。

### R05 — P2：知识包导入访问目录外文件（P2）

位置：`knowledge/transfer.ts:210`、`:303`，knowledge-export Schema 的 file 字段。entries.file='../outside.md' 或包内 symlink 指向包外 sentinel，导入均生成候选。证据：[p0-p2.log](evidence/2026-10-13/p0-p2.log)。内容哈希证明正文一致，不证明访问范围。

修复：所有正文／checkpoint 引用读前做路径与 realpath 根范围校验；同一份读入内容用于哈希与导入。复验 traversal、绝对路径、symlink 越界拒绝且零数据库变化；合法包往返不回退。

### R06 — P2：摘要知识没有修订增量（P2，影响 P3）

位置：`documents/checkpoint.ts:107`；objects-and-state-machines §4。两份不同摘要和待办写入后 knowledge_revision 2→2。证据：[knowledge-receipts.log](evidence/2026-10-13/knowledge-receipts.log)。准备后摘要变更无法使知识基线失效。

修复：区分只读快照与摘要／决策／待办知识提交，后者同事务增版本，保留来源；同步 CAS 和规范。复验准备后更新摘要使旧 bundle 失效，新准备含新摘要。

### R07 — P1：角色材料没有载入，交接替换为空摘要（P3，影响 P4/P5）

位置：`sessions/open.ts:106`、`sessions/handoff.ts:136`、`:151`、`requests/executor.ts:84`。初开只建 adapter=core、host_session_ref=null 的记录；继承 bootstrap 仅包含契约/checkpoint ID 和哈希，接口无取正文契约，角色指令、文档正文没有送达；prepare 又新建 summary=''、todos=[]，已保存摘要和待办不在继承 checkpoint 内。证据：[p3-p5.log](evidence/2026-10-13/p3-p5.log)。引用和外层哈希确认不能证明角色知识已经被宿主消费。

修复：传送固定契约的角色材料和授权知识正文／来源，或实现受限的内容解析协议及载入确认；保持已提交摘要/决策/待办。复验首次和继承会话都实际获得唯一正文标记，前任主历史不变；请求仅载入可分享材料。

### R08 — P1：重启恢复丢失 Bootstrap payload（P3）

位置：`sessions/handoff.ts:71`、`:278`。意图／provisioning 已落库而宿主尚未创建时，rehydrate 取 payload='' 但保留非空 payload_hash，恢复创建被宿主哈希校验拒绝。证据：[p3-p5.log](evidence/2026-10-13/p3-p5.log)最后一项。旧主指针未损坏，但无法按记录恢复。

修复：完整持久化并恢复不可变 payload；覆盖外部动作前后退出点。复验原基线恢复成功、无重复宿主和任职，不确定时不盲目重试。

### R09 — P2：幂等返回的代次及 resume 成功语义错误（P3）

位置：`sessions/open.ts:87`、`:301`。gen1 创建键在 gen2 后重放，返回 gen1 session/instance 却 generation=2；无 host_session_ref 时 Mock 的 nativeResume=true 路径仍报 resumed=true/method=native。证据：[p3-p5.log](evidence/2026-10-13/p3-p5.log)的 replay；resume 代码及既有测试固化无宿主路径。

修复：幂等返回原实例完整信息与实际状态；本地会话活跃和发生原生宿主恢复分开表达。复验旧键重放不冒称当前代次，无宿主不报原生恢复成功，恢复不增代次。

### R10 — P1：请求策略与隔离能力未执行（P4，影响 P5）

位置：`requests/service.ts:155`、`requests/executor.ts:184`。grants={}、isolation.context=false、level=restricted 仍完成请求。证据：[p3-p5.log](evidence/2026-10-13/p3-p5.log)第一项。adapter 的受限声明存在，但核心没有据此拒绝任务。

修复：创建和执行均检查有效策略／请求作用域，在花费宿主动作前确认必需隔离；把权限子集传给支持的宿主，不仅生成独立目录。复验撤权、任一隔离缺失均在 runTurn 前拒绝，授权完整隔离才运行。

### R11 — P1：取消可复活、期限后仍完成（P4）

位置：`requests/executor.ts:249`、`:254`。宿主 getResult 期间取消，needs_input 返回后无条件写 awaiting_input，将 cancelled 复活；结果取得时 deadline 已过也登记 completed。证据：[p3-p5.log](evidence/2026-10-13/p3-p5.log)，期限反例使用短 deadline 与实际等待，未修改请求期限。

修复：每个异步宿主返回后，在事务中统一重读状态、期限与授权；终态不可覆盖；artifact/inbox/终态同事务提交。复验取消/到期与 needs_input、预算失败、完成交错都保持终态，不留产物或可采纳候选。

### R12 — P1：预算支出后才检查，结果是固定说明，宿主未回收（P4，影响 P5）

位置：`requests/executor.ts:235`、`:263`、`ports/adapter.ts:68`。max_turns=1 的澄清回复实际花费第二轮后才 failed；artifact 正文固定为 Result for...，没有承载宿主答案；结果仍 running 也会进入完成；正常/失败只清核心 tmp，宿主 closed=false。证据：[p3-p5.log](evidence/2026-10-13/p3-p5.log)及适配结果接口。

修复：执行前预留预算，按宿主真实执行／完成语义和结果载体处理；实际回答入内容寻址 artifact 并计量；终态关闭／回收宿主，回收失败可重试。复验不会花第 N+1 轮，异步 running 不完成，真实答案哈希匹配，失败和完成资源均回收。

### R13 — P1：轮次断线与不确定创建无法可靠对账（P4，影响 P5）

位置：`requests/executor.ts:108`、`:235`，`requests/service.ts:327`。lookup 方法被抽出裸调用导致 this 丢失；Mock uncertainCreate 立即 TypeError。runTurn 断线后请求永久 running 且 execution_uncertain=0，重试被拒；DB 不确定标记=1 时公开 get 却读不存在的 execution_uncertain_flag，隐藏状态。证据：[lookup-this.log](evidence/2026-10-13/lookup-this.log)、[p3-p5.log](evidence/2026-10-13/p3-p5.log)。

修复：保留方法接收者，外部动作之前持久化创建／轮次意图及执行键，异常映射 failed 或待对账；公开结果读取正确字段。复验创建与执行的“副作用发生、确认丢失”均能可靠查询或明确不确定，不重复有副作用轮次。

### R14 — P2：重叠执行没有事务领取，十并发证据不足（P4）

位置：`requests/executor.ts:198`、`:222`；`requests.test.ts:202`。两个重叠 execute 都读取 accepted 并调用 createSession，第二次 UNIQUE constraint 失败。既有十请求测试逐个 await execute，并未测试实际重叠执行。证据：[p3-p5.log](evidence/2026-10-13/p3-p5.log)。此次反例观察到两次创建调用和一个正式结果，不能据此声称已经重复发布两次。

修复：执行前事务领取／持久执行标记及对账；重复投递返回一致状态。复验真实重叠十请求和同请求重复投递，用可控屏障证明重叠，不只 Promise 包装串行；断言消息、目录、结果、权限独立和每请求只一个正式产物。

### R15 — P2：桥接 cancel 声明没有执行效果（P5）

位置：`adapters/process-bridge/src/index.ts:237`、`host/fixture-host.mjs:194`。cancel 写 cancel.requested，fixture turn 从未消费标记；已存在取消标记后仍 accepted=true、turn_index 增长。证据：[bridge-cancel.log](evidence/2026-10-13/bridge-cancel.log)。这只证明夹具取消语义缺失，不代表未配置真实宿主的行为。

修复：兑现取消协商、阻止后续轮次并定义已运行轮次处理；或声明 cancel=false 且核心按不支持拒绝。复验 cancel 后 turn 不再支出，迟到产物拒收，相关状态和资源闭合。

## 5. 外部缺口与流程事项

**G01 — P1，BLOCKED：真实 Harness。** 当前只交付 Mock 和固定回答 fixture；本轮没有用户指定并授权的真实宿主接口输入。开发报告提及此前确认，本轮只核对“无实际交付／证据”，不把历史报告文字作为新的授权。所需输入：宿主名称／版本、官方调用和已有会话接入方式、允许使用范围。复验需真实角色载入、继承、独立请求、可读实际结果和去凭据版本日志。缺口未关闭前不能宣称 v0.1 原型完成。

**N01 — P2，报告基线。** P5-development 把尚未发生的提交／干净工作树写成事实。定稿时改为真实工作区或确切提交标识，记录差异再复验；“未提交”本身不要求本轮擅自提交，也不使全部实现无效。

## 6. 后续执行顺序

先执行 [返工提示](../../prompts/REWORK.md)，按 R01→权限面 R02/R03/R10→知识 R04–R09→执行 R11–R15 的依赖处理，形成 P5-R 开发报告，再逐阶段复验受影响项。保留原标准，不能删除反例来维持旧 PASS。

随后按 [桌面与外部锚定计划](../DESKTOP_GUI_PLAN.md)执行 P5-A/P5-H/P6-G/P6-R。用户授权的角色由 Agent 显式锚定，但授权来源、会话身份与核心策略先核实；GUI 不自建聊天 Harness。此验收和计划不自动实施产品、提交代码或发布远程产物。
