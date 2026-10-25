# P5-A 开发报告：受信授权、同会话锚定和共享服务

日期：2026-10-14  
状态：**待独立验收**  
独立验收定稿：**P5-A PASS（Linux 本地契约与参考运行时）**，见 [独立报告](P5-A-review.md)；上行保留开发提交时的流程状态。  
范围：`DESKTOP_GUI_PLAN.md` 的 P5-A；P5-R 本地独立 PASS 为前置。未实施 P5-H、GUI 或发布；P5 整体 G01 继续 BLOCKED。

## 1. 基线与交付

基线为 HEAD `a083874e60e7a40d88a18e075b699b1fb818b0e1` 加用户原有 P5/P5-R 未提交工作区，再叠加本轮 P5-A。没有重置既有工作、提交、推送或发布；完整 git diff 不能全部归为本阶段。进入时状态见 [baseline-status.txt](evidence/2026-10-14-p5-a/baseline-status.txt)，定稿前工作区见 [final-worktree-status.txt](evidence/2026-10-14-p5-a/final-worktree-status.txt)。

最终产品/配置84文件由 [implementation.sha256](evidence/2026-10-14-p5-a/implementation.sha256) 固定，清单摘要 `05cb3b88ab596a00f19e7abdace670b0f478e57cd86230119330661cc65def29`；测试/夹具52文件由 [tests.sha256](evidence/2026-10-14-p5-a/tests.sha256) 固定，清单摘要 `400b3aae0c37cf346e880e7ba2876c1ccfd19eea5a0476abffc0a8e515e55aa8`。两份逐文件校验退出0，见 [产品校验](evidence/2026-10-14-p5-a/implementation-check.log)、[测试校验](evidence/2026-10-14-p5-a/tests-check.log)。清单包括既有实现，排除构建产物；独立验收另行选取并校验产品清单，结果由独立报告记录。

交付包含：

- ADR-0009、四个协议对象及锚定材料/会话操作/受信控制输入 Schema；RoleHead 可服务主指针允许 null，保留单调 generation。Schema 是契约权威，TS 镜像同步。
- Migration 6，新增外部会话、授权来源、锚定尝试、载入审计和绑定；请求记录发起/目标授权来源。前五个 migration 保持原校验和。
- Core 的 `ExternalSessionAuthority` 与普通 `SessionConnection`；原18个本地 SDK 操作保留，受信控制与普通连接面分离。
- `packages/service` 可运行 Linux Unix socket 单 writer 服务、所有者/受信宿主/普通会话三种独立凭据、outbox 消费和撤权/到期回收。`packages/mcp` 提供14个普通会话工具，stdio 客户端连接该服务，不开数据库。
- Mock 已有会话与原始人类事件夹具；process-bridge 未声明外部会话锚定能力，不用固定回答伪装真实宿主。

MCP 使用官方 SDK **1.32.1**，精确依赖及锁文件已固定，官方来源与基线更新见 `docs/toolchain.md`；Node 22.23.2 / npm 10.9.8 / SQLite 基线不变。实际 npm 元数据见 [npm-sdk-metadata.json](evidence/2026-10-14-p5-a/npm-sdk-metadata.json)。

## 2. 行为与验收条件

| P5-A 条件 | 实际实现和断言 |
| --- | --- |
| 受信身份和授权来源 | 宿主适配器验证已有聊天、连接主体和原始人类事件引用；来源引用持久化，不保存原始私人消息。文档/模型/工具来源拒绝；所有者降级显示 owner-selection。来源重放保留旧契约/主指针基线，JSON 字段顺序不影响幂等；修改实际授权内容冲突。 |
| 普通会话不能签发或冒用 | 服务 bearer 固定主体/外部会话；会话 Schema 禁止 session_id/workspace_id 覆盖及管理员字段；跨聊天/跨工作空间消费授权拒绝。MCP 工具列表无授权签发/注册/管理员/内部执行入口，两真实 stdio 子进程实际验证隔离。 |
| 同一已有聊天载入后激活 | 角色指令、模板、Schema 引用闭包、授权文档正文/来源、继承 checkpoint 内容寻址持久化；不传私人聊天和 private 文档，不调用 createSession 偷开聊天。载入 intent 先落库，ack 必须匹配 host/load_key/hash/version，随后 CAS 一次激活。 |
| 并发与代次 | 同键重叠调用共用尝试，异键并发待载入被拒绝，同键不同授权冲突；两会话接任仅一个 CAS 胜者，失败方不能更新授权基线或自动覆盖。已有绑定恢复不增代次；释放后不能在原聊天换角色。 |
| 知识变化与失败保护 | 知识漂移重新准备最新正文及新载入键，审计保留全部载入；主代次漂移失败。载入期间释放/撤销即使又遇知识漂移，也保持 failed，不重新载入或激活。旧主指针在成功 CAS 前不变。 |
| 重启与不确定结果 | loading/uncertain 恢复查询原 load_key；已载入仅取原确认，可靠 absent 才使用原键载入，unknown/暂时查询失败继续 uncertain，禁止新键绕过。真实 SIGKILL 覆盖载入前、载入后未确认、激活后恢复；持久 fixture 断言唯一载入/代次。 |
| 撤权/到期/释放 | 实时动作权限是授权、固定载入上限与当前策略交集，直接 SDK 也检查绑定。释放/撤销/到期使当前指针 null、代次不回退，旧任职不恢复。未完成请求的派生授权一并撤销，快照保留；迟到结果拒收；close 失败的分支仍不能提案。 |
| 共享 writer 与服务恢复 | 多连接共用一份 Coordinator/WorkspaceAdmin，原 CLI 直接写库报 WORKSPACE_LOCKED。socket0600、凭据256位随机；服务进程 SIGKILL 后持锁恢复陈旧自有 socket、更换全部凭据并保留状态；活 socket/普通文件/symlink 不盲删。 |
| 服务独立请求处理 | 服务实际消费 outbox，固定 fixture 回答形成可读 artifact/收件箱；不注入原聊天。独立 expiry sweep 在外部 runTurn 等待确认时仍转终态并请求取消，不依赖执行 worker 返回。回收失败持久记录并重试，不假报宿主已停止。 |
| 通用角色与真实能力边界 | 核心及 service/mcp 无业务角色硬编码；角色材料来自包数据。旧334测试保留并全量回归；适配器缺少外部身份/载入声明或方法明确 ADAPTER_CAPABILITY_MISSING，缺少可靠对账保持 uncertain。未交付的功能不返回假成功。 |

主要断言位置：`packages/core/test/anchor.test.ts`、`packages/protocol/test/anchor-schemas.test.ts`、`packages/service/test/service.test.ts`、`packages/mcp/test/mcp.test.ts`、`tests/integration/anchor-recovery.process.test.ts`、`tests/integration/service-restart.process.test.ts`。规范与用法见 [锚定契约](../spec/external-session-anchor.md)、[共享服务/MCP](../service-and-mcp.md)、[ADR-0009](../adr/0009-trusted-connections-and-anchor.md)。

## 3. 实际验证与迭代

全部工作空间为临时本地夹具；不使用真实模型、账户或 Harness 凭据。新增测试无 skip。Unix socket 与实际子进程验证在本地进程环境执行并获自动审批，沙箱拒绝监听不算通过。

| 命令/验证 | 结果与采用方式 |
| --- | --- |
| `npm ci --ignore-scripts` | 精确锁文件安装成功、退出0，143 packages，audit 0 vulnerabilities：[npm-ci.log](evidence/2026-10-14-p5-a/npm-ci.log)。 |
| 初始类型检查 | 迭代中实际出现返回类型/MCP Schema 类型不匹配，修正后通过；保留 typecheck-initial 至 ninth 日志，不将失败记录计为成功。冻结前独立类型检查退出0：[typecheck-final-candidate.log](evidence/2026-10-14-p5-a/typecheck-final-candidate.log)。 |
| 初始锚定专项 | 15测试通过、退出0，80.69秒；后续独立边界修复后不作为最终产品证据：[anchor-initial.log](evidence/2026-10-14-p5-a/anchor-initial.log)。 |
| 首次通信/恢复专项 | 15通过/8失败，114秒；Unix socket 沙箱 EPERM 和崩溃夹具缺少 keepalive 导致提前退出，均完整保留：[focused-first.log](evidence/2026-10-14-p5-a/focused-first.log)。修正夹具、使用正常本地传输后重跑。 |
| 通信/恢复第二次专项 | service/MCP/anchor进程恢复3文件、8测试通过，退出0，37.79秒：[transport-recovery-second.log](evidence/2026-10-14-p5-a/transport-recovery-second.log)。产品后续修正后仍需最终门禁。 |
| 候选专项 | 6文件29通过/1失败，176.80秒，退出1；一秒到期前置因fsync耗时在激活前已过期，读null失败。调整真实到期窗口并按持久 expires_at 等待，保留激活前置断言、继续实际跨越到期，不修改数据库时间：[focused-final-candidate.log](evidence/2026-10-14-p5-a/focused-final-candidate.log)。 |
| 冻结最终 `npm run check` | **typecheck→build→Vitest完整结束，34文件、372测试全部通过，0跳过，630.23秒**：[check-final.log](evidence/2026-10-14-p5-a/check-final.log)。用户续转后原工具会话失效，未取回最终进程退出码；不补写exit0，以完整通过结尾记录结果。运行期间产品和测试基线均冻结。 |
| 最终源码/测试及差异检查 | 两份 sha256 逐文件校验、`git diff --check` 实际退出0；证据见第一节。 |
| 独立最终专项与四个反例 | **5文件29测试通过、0跳过、207.13秒、实际退出0**，四个冻结反例脚本均实际退出0；84产品/52测试清单由验收方再次逐项校验通过，见 [独立报告](P5-A-review.md)。 |

独立验收 Agent 在开发过程中实际复现释放+知识漂移复活尝试、释放后宿主关闭失败的分支仍可提案、原始事件字段换序误判冲突。代码审查另发现外部轮次长期pending会阻塞服务到期回收；该项首轮脚本运行跨编译过渡，不能作为旧产品基线的可靠缺陷复现。四项均已由开发方修复并纳入回归。反例/前后日志保留在 `evidence/2026-10-14-p5-a-independent/`，最终复验与是否关闭由独立报告裁定。开发方另补充暂时对账异常保持uncertain的组合测试，防止新键重放副作用。

## 4. 边界与阶段门槛

本阶段提供外部会话适配契约和 Linux 本地服务/MCP参考实现。Mock事件、材料确认、固定回答及真实fixture子进程只能证明本地协议、事务、权限和进程恢复；不能证明真实用户授权来源、真实聊天消费材料或模型协作。

G01 仍 **BLOCKED**：P5-H 尚需用户指定并授权真实 Harness 名称/版本、受支持接口、当前聊天定位、人类事件及载入确认方式、账户和任务范围。未创建不可运行的 harness-reference 或 desktop 空壳包；没有 GUI、跨平台打包或远程发布证据。

原CLI为受信本地维护面，服务运行时直接写库明确 WORKSPACE_LOCKED；未将它改成普通会话客户端。重启后 bearer 全部失效，受信接入组件重新登记相同已有聊天可恢复原绑定而不增加代次。宿主无法查明载入/执行副作用时保留待对账；资源清理不能保证外部模型已经终止。发布历史和接收快照不可变。

P5-A 独立验收后才可考虑下一子阶段。本轮止于 P5-A，不解除 P5整体及 v0.1 原型的真实宿主门槛。
