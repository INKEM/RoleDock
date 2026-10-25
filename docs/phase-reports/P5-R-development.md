# P5-R 开发报告：P1–P5 复验返工

验证日期：2026-10-13；定稿日期：2026-10-14  
状态：**待独立验收**  
独立验收定稿：**P5-R 本地 PASS、P1–P4 PASS；P5 整体因 G01 BLOCKED**，见 [独立验收报告](P5-R-review.md)。上行保留开发提交时的流程状态。  
范围：`P0-P5-revalidation.md` 的 R01–R15 与 N01；本地通用运行时。G01 真实 Harness 继续单独挂账，不进入 P5-A／GUI。

## 1. 基线与变更

HEAD 为 `a083874e60e7a40d88a18e075b699b1fb818b0e1` 加用户已有 P5 未提交工作区。返工前运行构建与专项反例，复现引用、授权、基线和路径问题。完整保留原工作区，本轮未提交、推送或发布，未改依赖版本和工具链；git diff 包含之前的 P5／计划变更，不能全部归为本次返工。

最终实现／测试共107文件：[implementation-final.sha256](evidence/2026-10-13-p5-r/implementation-final.sha256)，清单哈希 `ababb56ab36733b7723d06460974f44c171f8cad899c3d63a34268e9faee71ba`，逐文件核验见 [hash-verification.log](evidence/2026-10-13-p5-r/hash-verification.log)。独立验收另取64个产品／配置文件，范围不含测试，清单哈希 `b0517900bd4d79c70b65eb59bf12e3b69388676e86845413712f9a5be58c9100`；两份清单范围不同，不要求哈希相同。实际工作区见 [worktree-status.txt](evidence/2026-10-13-p5-r/worktree-status.txt)，dist 为测试构建产物，不作源码基线。

新增 ADR-0008 与 migration 5；migration 1–4 保持校验和不变。生产根导出收口，低层存储／任职／回执只留显式测试入口；Coordinator 的状态用 ECMAScript 私有字段持有。文档动作检查实时策略，请求接收与执行分别检查策略及隔离，接收快照限制分支的 list/read/propose。SDK／CLI 仍是可信本地控制器，外部会话授权与锚定留待 P5-A。

首次、继承和请求会话实际载入固定契约的角色材料与授权知识正文／来源。继承完整 payload 内容寻址持久化，保留摘要／决策／待办；知识变动使旧 bundle 失效。用户逻辑打开键与内部宿主创建键分开；重放返回原实例的代次和状态。

请求执行先持久化创建／轮次意图与预算预留，再执行外部动作；失去轮次确认只查询，不重发。每个异步返回后重读终态、期限和当前策略。匹配执行键、明确完成且可读的真实回答才登记 artifact，结果／收件箱／终态原子提交。终态关闭宿主和临时目录，回收失败持久化并可重试。Bridge 的取消标记阻止新轮次，已运行迟到结果由核心拒收。

## 2. 返工对照与行为证据

| 编号 | 实施与复验断言 |
| --- | --- |
| R01 | Schema 完整本地引用闭包、循环安全；URI／fragment、常规文件与 realpath 范围检查；远程、目录、缺失及越界拒绝 |
| R02 | 底层服务实时 grants；无授权／撤权读写与提案拒绝，修订／候选／回执数量不变；授权后允许 |
| R03 | 生产根无存储／任职／签回执捷径，深导入被 exports 拒绝；回执必须关联实际目标文档、版本与哈希，正常读可请求 |
| R04 | 明确旧编辑基线保留；新版存在时保存原正文候选，采纳冲突且候选仍 open |
| R05 | 所有文档／checkpoint 文件读前做根范围校验，单份 Buffer 用于哈希和导入；traversal／绝对路径／symlink 拒绝且零数据库变化 |
| R06 | 摘要／待办／决策／来源提交变化同事务增知识修订，只读快照不增；旧 bundle 激活拒绝 |
| R07 | 首次及继承含唯一角色指令与知识正文标记；保留已提交摘要／待办；private 不传递，请求仅 project/public；主 transcript 不注入 |
| R08 | 完整 payload 持久恢复；真实协调器进程在 create 前／create 后确认前退出，再开恢复为唯一 gen2／唯一宿主，旧主指针在激活前保持 gen1 |
| R09 | 旧键返回原实例代次；无宿主不宣称 native 恢复；初开和继承原生恢复均使用持久宿主创建键；Mock 数值宿主 ID 重用时旧键句柄不可操作新会话 |
| R10 | 请求接收、执行与 post-await 策略；任一隔离缺失在花费前拒绝；固定能力子集和材料快照，分支默认读与提案基线不追随最新 |
| R11 | 可控取消与 needs_input／完成／预算失败交错、实际等待跨 deadline；终态不复活，无产物／收件箱；get/reply/cancel 到期均提交并回收 |
| R12 | 预留轮次阻止第 N+1 轮；running 不完成；实际回答正文／哈希与字节计量；显式拒绝／缺正文为已知失败；完成／失败关闭且回收可重试 |
| R13 | lookup 保留方法接收者；公开正确 uncertainty 字段；真实进程在 runTurn 前／副作用后确认前退出，不重发；前者保留待对账可取消，后者查到真实答案且只一个 artifact |
| R14 | 屏障证明十个 runTurn 同时进入，每个独立目录／标记／作用域／宿主／结果；同请求重叠投递共享执行，终态投递返回原结果；用户逻辑键不能别名请求宿主 |
| R15 | mock/bridge 共用取消与按执行键去重契约；取消后新 turn 不支出；真实 bridge 断线恢复读取最后落盘轮次 |
| N01 | P5-development 更正未发生的提交和“干净”声称；按实际 HEAD＋未提交工作区记录，旧开发 PASS 不作为当前基线 |

主专项：`packages/core/test/rework.test.ts`。实际进程退出点：`tests/integration/runtime-recovery.process.test.ts`。适配器共享契约：`tests/conformance/adapter-suite.ts`。原状态、权限矩阵、导入往返、CLI 与演示测试继续保留，正例由本地所有者测试配置明确 grant；不把包声明自动授权。

## 3. 实际执行

环境：Node 22.23.2、npm 10.9.8。全部验证只用临时模拟工作空间和固定回答 fixture，无真实凭据、外部目标或真实模型。

| 命令／验证 | 实际结果与证据 |
| --- | --- |
| 返工前 `npm run build` 与原复验脚本 | 构建成功；缺陷重现：[baseline-build.log](evidence/2026-10-13-p5-r/baseline-build.log)、[before-loader.log](evidence/2026-10-13-p5-r/before-loader.log)、[before-p0-p2.log](evidence/2026-10-13-p5-r/before-p0-p2.log)、[before-p3-p5.log](evidence/2026-10-13-p5-r/before-p3-p5.log) |
| 返工过程中专项与回归 | 初始 35 专项通过；后续回归／独立反例继续修正。迭代日志完整保留，不冒称中途全绿：[rework-first.log](evidence/2026-10-13-p5-r/rework-first.log)、[core-third.log](evidence/2026-10-13-p5-r/core-third.log) |
| 第一轮完整 `npm run check` | typecheck/build 成功，321 passed／4 failed。旧 bridge 正文期望与演示重复投递语义、锁 probe 的生产导出遗漏已修正；锁测试失败留下 worker，清理本轮精确 PID 后退出1：[check-final.log](evidence/2026-10-13-p5-r/check-final.log) |
| 实际退出测试开发迭代 | 第一轮 setup 混用了 source/dist WeakMap；第二轮测试访问 handoff 元数据层级与不存在的零轮次 transcript 文件有误，均修正；不是产品成功证据：[process-recovery.log](evidence/2026-10-13-p5-r/process-recovery.log)、[process-recovery-second.log](evidence/2026-10-13-p5-r/process-recovery-second.log) |
| 第二轮 `npm run check` | 331 passed／1 failed，28 文件，484.24 秒，退出1。运行期间独立审查补入 legacy cancel／Mock 句柄防护，未冻结基线；唯一失败是新增 legacy cancel 场景观察到取消调用计数1，不能作最终成功证据，需冻结源码重跑：[check-final-second.log](evidence/2026-10-13-p5-r/check-final-second.log) |
| 第三轮 `npm run check` | **28文件、332测试通过，0跳过，492.23秒，退出0**；定稿时继续独立复现 cancel 抛错跳过回收，追加修正后进入最后门禁：[check-final-third.log](evidence/2026-10-13-p5-r/check-final-third.log) |
| 第四轮 `npm run check` | 333／334通过，28文件，521.76秒，退出1；唯一失败为锁测试 holder 的未引用 DatabaseSync 被GC释放锁。对照强制GC时闲置绑定 probe=OPEN、保留绑定 probe=WORKSPACE_LOCKED，holder都存活；修正测试夹具持有引用并在ready前强制GC：[check-final-fourth.log](evidence/2026-10-13-p5-r/check-final-fourth.log)、[lock-gc-proof.log](evidence/2026-10-13-p5-r/lock-gc-proof.log) |
| GC生命周期锁专项 | 强制GC后另一进程仍被锁、SIGKILL后可恢复，1／1通过，3.25秒，退出0：[lock-gc-regression.log](evidence/2026-10-13-p5-r/lock-gc-regression.log) |
| 最终冻结源码 `npm run check` | **typecheck/build 完成，28文件、334测试全部通过，0跳过，217.16秒**；修正锁夹具不改变产品实现：[check-final-fifth.log](evidence/2026-10-13-p5-r/check-final-fifth.log)。跨夜恢复时原工具会话已失效，退出码未取回，不补写退出码；完整日志保留全部门禁步骤及通过结尾 |
| 独立复验 | 七个边界、Mock 身份隔离、取消失败仍关闭和关闭失败重启重投回收的独立场景均通过；2026-10-14 定稿为 P5-R 本地 PASS，见 [独立报告](P5-R-review.md)：[verify-boundaries-final.log](evidence/2026-10-13-p5-r-independent/verify-boundaries-final.log)、[verify-mock-identity.log](evidence/2026-10-13-p5-r-independent/verify-mock-identity.log)、[verify-cancel-cleanup.log](evidence/2026-10-13-p5-r-independent/verify-cancel-cleanup.log) |

子进程测试在正常本地进程环境执行，获得自动审批；沙箱内子进程管道限制记录在迭代日志中，不列为产品缺陷。新增测试没有 skip。

2026-10-14 恢复后重新核验两份源码清单，逐文件均一致；工作区差异格式检查通过。复核日志：[implementation-final-check.log](evidence/2026-10-13-p5-r/implementation-final-check.log)。独立结论另见 [P5-R-review.md](P5-R-review.md)。

## 4. 剩余边界与后续

G01 仍 **BLOCKED**：没有用户指定并授权的真实 Harness 名称／版本、接口和允许范围。Mock、真实 fixture 子进程与两遍 demo 只能证明本地运行时／协议边界，不能证明真实角色消费或模型协作，不能宣称 v0.1 原型完成。

缺少持久材料的旧 bundle／请求返回 NOT_IMPLEMENTED，需重新准备／接收；migration 不伪造过去未保存的正文。未知轮次不能查明时保持 execution_uncertain，不盲目重发；撤权可终止，但实际未知副作用仍诚实保留标记。资源回收依赖后续投递／读取重试，本阶段不新增常驻调度服务。

公开 createRequest／CLI create 只接收并写 outbox，不自动完成初始执行。本地 demo 使用受信所有者 driver 调用内部执行引擎；该内部导入和 testing 入口不得暴露为会话工具。生产自动 outbox 消费与共享协调服务尚未交付，后续按 P5-A／共享服务阶段实现受信运行面；本轮只验收引擎被投递时的正确性。

独立验收已按 P1–P4 和 P5 本地条件复核通过；后续可按流程考虑下一子阶段 P5-A，本轮止于 P5-R。
