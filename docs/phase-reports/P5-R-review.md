# P5-R：P1–P5 返工独立验收（本地 PASS）

定稿日期：2026-10-14（行为验证于 2026-10-13 执行）  
验收方：独立 Codex 验收 Agent；未修改产品实现  
范围：P5-R 本地运行时返工；不包含 P5-A、真实 Harness 或 GUI

## 1. 结论与基线

结论：**P5-R 本地返工 PASS，P1–P4 复验 PASS；P5 本地条件 PASS，P5 整体仍 BLOCKED（G01）**。R01–R15 已关闭，N01 的错误提交／干净工作树声明已更正。P0 维持此前 PASS；本次完整门禁还覆盖其跨进程锁回归。验收基线是 HEAD `a083874e60e7a40d88a18e075b699b1fb818b0e1` 加保留的用户既有 P5 未提交工作区及本次返工，以本报告的两份文件清单固定。

已独立阅读仓库约束、蓝图、工具链、桌面计划、ADR-0007/0008、COMMON、REVIEW、05R 提示词、P0–P5 复验与最终开发报告，并检查产品源码、实际行为和验证证据。完整门禁由开发方运行，验收方独立检查日志；验收方另实际运行七个边界场景、Mock 句柄隔离及两个取消回收场景，全部退出 0。2026-10-14 再次校验产品与实现／测试清单，全部一致，旧通过证据仍对应最终产品。

主方完整门禁证据经独立阅读，不将阶段中途失败或旧基线通过视为最终成功：

| 运行 | 结果与采用方式 |
| --- | --- |
| 第一轮 | 321 passed／4 failed；旧桥接期望、重复投递语义及锁 probe 导出修正后重跑，不计最终通过 |
| 第二轮 | 331 passed／1 failed；运行中补入最后边界修复，未冻结基线，不计最终通过 |
| 第三轮 | 332/332 passed，28 文件，492.23 秒；随后补取消异常回收，不能替代最终产品基线 |
| 第四轮 | 333 passed／1 failed，28 文件，521.76 秒；锁 fixture GC 生命周期错误，真实对照后修正，不计整轮通过 |
| 第五轮 | typecheck → build → Vitest 完整日志，**28 文件／334 测试全部通过，无跳过，217.16 秒**：[完整门禁日志](evidence/2026-10-13-p5-r/check-final-fifth.log)。跨夜原工具会话失效，未取回最终进程退出码；以完整日志的通过结尾记录结果，不声称观察到退出码 0 |

逐阶段结论：

| 阶段 | 判定 | 对应条件 |
| --- | --- | --- |
| P0 | 维持 PASS | 工具链未改，基础检查与真实跨进程持锁／退出恢复回归通过 |
| P1 | PASS | R01 包引用闭包、文件及 Schema 校验通过 |
| P2 | PASS | R02–R06 实时授权、正式入口、编辑基线、导入路径及知识修订通过 |
| P3 | PASS | R03、R06–R09 固定材料、主指针／代次、继承恢复及幂等通过 |
| P4 | PASS | R02–R04、R07、R10–R14 本地 SDK 权限、接收绑定与执行引擎边界通过 |
| P5 | 本地条件 PASS；整体 BLOCKED | R07、R10、R12–R15 及 bridge 协议边界通过；G01 真实 Harness 尚缺外部证据 |

## 2. 逐项复验

| 编号 | 阶段 | 实际实现／证据 | 本地判定 |
| --- | --- | --- | --- |
| R01 | P1 | loader 的本地引用闭包、fragment/anchor 校验和 confinedFile 常规文件/realpath 边界；递归闭包与远程、越界、目录、symlink 反例 | PASS |
| R02 | P2/P4 | 文档底层服务及请求入口读取实时 policy；撤权后读写/候选/回执与宿主动作拒绝 | PASS |
| R03 | P2/P3/P4 | 正式 index 移除存储/任职/回执签发；包 exports 仅正式入口与显式 testing；真实回执需对应目标文档精确版本及哈希 | PASS |
| R04 | P2/P4 | 保留显式旧编辑基线；请求分支省略基线时固定接收修订，不以最新修订抬升；独立脚本复现旧内容采纳冲突 | PASS |
| R05 | P2 | 文档/checkpoint 引用在读前验证词法和 realpath 范围，缓存验证过的正文用于导入；拒绝时无候选写入 | PASS |
| R06 | P2/P3 | 摘要/决策/待办/来源变化与 checkpoint 同事务增知识版本；未指定材料保留上次提交；知识变化使旧交接失效 | PASS |
| R07 | P3/P4/P5 | 初开实际创建宿主并载入角色材料；继承传完整固定材料、正文/来源及已提交摘要；请求只传接收时 project/public 正文 | PASS |
| R08 | P3 | payload 内容寻址持久化后创建宿主；恢复取原正文并按创建键对账；实际协调器进程在创建前后退出的回归 | PASS |
| R09 | P3 | 逻辑打开键与宿主创建键分离；重放返回原实例代次/状态；无宿主不报 native 恢复成功 | PASS |
| R10 | P4/P5 | 接收与执行核对 live policy、任务能力子集与四项隔离；请求 read/list/propose 均固定接收快照；独立逻辑键不能 alias 主宿主 | PASS |
| R11 | P4 | 宿主 await 返回后事务重读终态、期限和授权；取消/到期不复活；到期 reply/cancel 拒绝前提交 expired；完成产物/收件箱/终态原子提交 | PASS |
| R12 | P4/P5 | turn 预算在 runTurn 前预留；running 不完成；actual body 内容寻址；缺正文/明确拒绝为已知失败；取消事务设 cleanup_pending，cancel 异常也必走 cleanup；关闭失败持久待回收，重启重投清理且无新轮次 | PASS |
| R13 | P4/P5 | bound lookup 保留接收者；创建/轮次意图与执行键持久化；确认丢失只对账；公开 uncertainty 取实际字段；真实进程在轮次前后退出回归 | PASS |
| R14 | P4 | 同请求重叠投递共用 promise，外部动作前领取持久 phase；十个实际重叠请求由屏障证明，消息/目录/权限/产物独立 | PASS |
| R15 | P5 | fixture turn 消费 cancel 标记，取消后后续轮次拒绝；已开始轮次可返回但核心拒收迟到结果 | PASS |

实现与断言位置：R01 对应 `packages/core/src/roles/loader.ts`、`files.ts` 和 `test/rework.test.ts` 的引用闭包反例；R02–R04 对应 `documents/service.ts`、`policy.ts`、生产 `index.ts`／包 exports 和同一专项的授权、回执、基线断言；R05 对应 `knowledge/transfer.ts` 与四种恶意路径的数据库零变化断言；R06–R09 对应 `documents/checkpoint.ts`、`sessions/material.ts`／`open.ts`／`handoff.ts` 与固定材料、知识漂移、幂等和严格 nativeResume 断言。R10–R14 对应 `requests/service.ts`／`executor.ts`，专项实际覆盖四项隔离逐一缺失、授权撤销、可控异步取消、预算、正文、丢确认对账和十个同时到达 runTurn 屏障；`tests/integration/runtime-recovery.process.test.ts` 另覆盖宿主创建及轮次的外部动作前后真实退出。R15 对应 `adapters/process-bridge/host/fixture-host.mjs` 与 `tests/conformance/adapter-suite.ts` 的取消后禁新轮次／执行键去重断言。上述全部纳入完整门禁，独立脚本补充的反例见下一节。

## 3. 独立检查中发现并复验的补充边界

独立审查曾实际复现以下反例，反馈开发方后由开发方修复；验收方未修改产品实现：

1. 请求分支读取固定 V1，却列出 V2，并以 V2 为默认基线提出 EDIT-OF-V1，使主实例可直接采纳。现 read/list/propose 对齐接收快照，旧基线候选采纳冲突。
2. 用户打开键 `request-${request_id}` 与 executor 的宿主键碰撞，导致请求进入其他角色主会话。现逻辑打开键与内部宿主键分离，执行和清理另外验证 session.kind 与目标角色，主会话 transcript 无注入。
3. 明确 accepted=false 或 completed 缺正文被误记为 running/uncertain，宿主未回收。现为结构化已知 failed，无假 artifact，host 已关闭。
4. 等待输入后惰性到期只转 expired，没有回收宿主；reply/cancel 的异常还可回滚到期。现 get/reply/cancel 到期路径提交终态并回收。
5. Mock 的数值宿主 ID 在新适配器实例中重用，旧句柄误指新宿主并假报 native 恢复。现运行、读取、恢复、取消和关闭核验持久 creation_key；独立复跑五个旧句柄动作均 NOT_FOUND，新宿主无污染且可正常执行。
6. 恢复的交接遇到知识变化没有进入正常重准备/回收路径。现恢复冲突与新执行路径采用同一基线语义，另以稳定逻辑键保存幂等关联。
7. 初开和继承的 nativeResume 传递本地 session_id 而非持久宿主创建键。现使用原 creation_key，由严格句柄适配器断言覆盖两条路径。
8. **R12-C01（优先级 P1，已关闭）**：请求已 awaiting_input、适配器声明 cancel 但调用抛错时，旧 `requests/service.ts:463` 提交 cancelled 未设 cleanup_pending；旧 `executor.ts:219` 抛错跳过 cleanup，`coordinator.ts:410` 吞错返回 cancelled。验收方在修复前构建实跑 [反例](evidence/2026-10-13-p5-r-independent/repro-cancel-cleanup.mjs)，观察 `cleanup_pending=0`、`host_closed=false`、`temp_exists=true`：[之前日志](evidence/2026-10-13-p5-r-independent/repro-cancel-cleanup-before.log)。现取消事务登记 pending，try/finally 无论 cancel 结果均执行 cleanup；独立脚本覆盖关闭成功和关闭亦失败时 pending 持久、重启／重投回收，turn 数保持 1，无新产物。

[独立脚本](evidence/2026-10-13-p5-r-independent/verify-boundaries.mjs)使用临时模拟工作空间执行七个场景；最终冻结构建上运行 `node docs/phase-reports/evidence/2026-10-13-p5-r-independent/verify-boundaries.mjs`，实际退出 0，七项全部通过：[最终日志](evidence/2026-10-13-p5-r-independent/verify-boundaries-final.log)。补充运行 `node docs/phase-reports/evidence/2026-10-13-p5-r-independent/verify-mock-identity.mjs`，实际退出 0：[Mock 身份日志](evidence/2026-10-13-p5-r-independent/verify-mock-identity.log)。均为验收方实际运行。

新增运行 `node docs/phase-reports/evidence/2026-10-13-p5-r-independent/verify-cancel-cleanup.mjs`，实际退出 0；取消抛错仍关闭，以及关闭失败后持久待回收、Coordinator 重启后重投清理的两场景全部通过：[最终回收日志](evidence/2026-10-13-p5-r-independent/verify-cancel-cleanup.log)。该脚本首轮行为断言虽通过，finally 重复关闭已关的测试数据库导致退出 1，清理夹具修正后完整重跑；保留 [清理失败日志](evidence/2026-10-13-p5-r-independent/verify-cancel-cleanup-setup-failed.log)，不计为成功证据。

首次脚本的 800ms 到期前置时窗不足，执行时已正常过期；该前置失败单独保留为 [setup-failed 日志](evidence/2026-10-13-p5-r-independent/verify-boundaries-setup-failed.log)，修正为 20s 后重新运行，不计为产品失败或通过证据。中间通过日志同样保留，最后两项产品修正后的证据以上述最终日志为准。

最终产品基线由 [64 文件清单](evidence/2026-10-13-p5-r-independent/implementation-baseline.sha256)固定，包含 packages/adapters 的 src、schema、fixture host、包配置与根工具链／锁文件，排除 tests/dist；清单本身 SHA256 为 `b0517900bd4d79c70b65eb59bf12e3b69388676e86845413712f9a5be58c9100`。验收方执行 `sha256sum -c docs/phase-reports/evidence/2026-10-13-p5-r-independent/implementation-baseline.sha256`，64 文件全部成功、退出 0：[校验日志](evidence/2026-10-13-p5-r-independent/implementation-check.log)。修正 GC 夹具后同样验证产品清单未变。主方 implementation+tests 清单范围较广，不应与此清单摘要直接比较；其第五轮摘要为 `ababb56ab36733b7723d06460974f44c171f8cad899c3d63a34268e9faee71ba`。2026-10-14 两份清单再次逐文件校验均退出 0：[产品定稿校验](evidence/2026-10-13-p5-r-independent/implementation-check-final.log)、[实现与测试定稿校验](evidence/2026-10-13-p5-r-independent/implementation-tests-check-final.log)。旧清单及最后取消修复前的通过日志以 before-cancel-fix 名称保留，不能取代最终基线。

第四轮锁失败没有被忽略：`hold-workspace.mjs` 先前只让空计时器存活，store 没有持久引用，DatabaseSync 会在 GC 时关闭。主方强制 GC 对照显示进程均活跃时，unused 模式允许 OPEN，retained 模式返回 WORKSPACE_LOCKED：[诊断日志](evidence/2026-10-13-p5-r/lock-gc-proof.log)。现计时器闭包实际引用 store，ready 前强制 GC；进程测试声明 `--expose-gc`，且仍验证活跃持锁时第二进程拒绝及 SIGKILL 后恢复：[专项日志](evidence/2026-10-13-p5-r/lock-gc-regression.log)。此项只修改测试夹具与测试启动参数，没有改产品锁实现。验收方核查诊断脚本、两个 holder 变体及最终测试修正；额外独立 GC 复跑在用户中断前未取得输出，保留空的 interrupted 日志，不计成功证据。

## 4. 外部缺口与下一步

G01 保持 **BLOCKED**：Mock、process-bridge 与真实子进程退出测试证明本地状态/消息/进程边界；固定回答 fixture 不是模型，也不能证明真实 Harness 角色载入、继承或独立请求闭环。尚需用户指定并授权的宿主名称/版本、官方调用与已有会话接入方式、允许范围。

自动 outbox 服务尚未交付；公开 createRequest/CLI create 只接收，演示由受信所有者 driver 调用内部引擎。内部执行入口及 testing 不得注册为会话工具。资源回收的重试依赖后续投递/读取；缺材料的旧记录明确 NOT_IMPLEMENTED，未确认的轮次不重发。

本轮不实施 P5-A，不实现 GUI，不提交或发布远程产物。本地返工 PASS 后可按既定流程考虑下一子阶段 P5-A，本次不自动执行；G01 未关闭前 P5 总体及 v0.1 原型均不能宣称完成。
