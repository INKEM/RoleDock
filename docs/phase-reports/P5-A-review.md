# P5-A 独立验收：受信授权、同会话锚定与共享服务

日期：2026-10-14  
验收方：独立 Codex 验收 Agent；未修改产品实现  
结论：**P5-A PASS（Linux 本地契约与参考运行时）；P5 整体仍 BLOCKED（G01）**

## 1. 范围与冻结基线

已读取仓库指令、开发蓝图、工具链、桌面计划、COMMON、REVIEW、05A、ADR-0007/0009、身份/适配/锚定规范、P0–P5 复验、P5-R PASS 前置及最终 [P5-A 开发报告](P5-A-development.md)。检查源码、Schema、权限入口、实际状态断言和完整验证日志；不以开发报告的完成声明替代验收。

基线为 HEAD `a083874e60e7a40d88a18e075b699b1fb818b0e1`，保留用户既有 P5/P5-R 未提交工作，再叠加本轮 P5-A。工作区整体差异不能全部归因于本阶段。没有修改产品代码、提交、推送或发布；验收方只增加独立复现脚本、证据及本报告。

验收方独立生成的 [84 文件产品/配置清单](evidence/2026-10-14-p5-a-independent/implementation-baseline.sha256) 包含 packages/adapters 的源码、Schema、bridge fixture host、包配置与根工具链，不含 dist/tests；摘要为 `05cb3b88ab596a00f19e7abdace670b0f478e57cd86230119330661cc65def29`，与开发方同范围清单一致。初版83文件未包含根 tsconfig.base.json，定稿前已补齐并重验。最终专项及四个脚本后再次逐文件核验84项全部成功，实际退出0：[产品校验](evidence/2026-10-14-p5-a-independent/implementation-check-final.log)。验收方另实际核验开发方52文件测试/夹具清单，全部成功、退出0：[测试校验](evidence/2026-10-14-p5-a-independent/tests-check-final.log)。

## 2. 条件逐项验收

| 必需条件 | 实际文件、行为与证据 | 判定 |
| --- | --- | --- |
| P5-R/P1–P4 PASS 前置 | P5-R-review.md 确认本地返工 PASS；继承旧334测试并完整回归。G01 不是 P5-A 前置缺口的替代证据。 | PASS |
| 四对象、迁移、输入输出与错误契约 | protocol 的 external-session、role-authorization、anchor-attempt、session-binding、anchor-material 与控制/会话操作 Schema，TS镜像；migration 6 保存授权、尝试、载入历史、绑定与请求来源。既有迁移及工具链回归通过。 | PASS |
| 受信主体及具体授权来源 | core/sessions/anchor.ts 的 register/recordHumanAuthorization 校验宿主、工作空间、主体、事件引用；Mock 的模型/工具/文档来源均拒绝。所有者降级明确标为 owner-selection，不存原始私人消息。来源重放保留原授权与原基线，真实范围改变冲突。 | PASS |
| Agent 不能签发、冒用或打开写库 | 普通 SessionConnection 固定外部会话；service 所有者/受信事件/普通会话三种凭据及白名单独立。跨会话/工作空间授权、session_id/role_id 覆盖、授权签发、WorkspaceAdmin、testing、sessions.open 等失败且零任职变化。 | PASS |
| 原聊天载入后才 CAS 激活 | anchor.prepare 持久化完整内容寻址材料；外部动作前保存 loading；宿主确认严格匹配 host/load_key/hash/正整数version，再事务重验授权、策略、代次与知识修订。实际 Mock 断言原会话载入、私人历史不传输、未创建另一聊天。 | PASS |
| 并发、幂等、恢复与唯一绑定 | 同键重叠共用尝试；异键待决拒绝、同键不同授权冲突；两接任者只有一个 CAS 胜者，失败者不能覆盖胜者。恢复原绑定不增代次；释放后同聊天不能重新绑定角色。 | PASS |
| 知识变化与代次竞争 | 知识漂移生成新材料/新键，实际新正文及载入审计均有断言；代次漂移明确 GENERATION_CONFLICT，保持授权原主基线。A01 修复后，释放与知识变化组合不复活、不再次载入、不改变旧主指针。 | PASS |
| 载入不确定及中途退出 | loading/uncertain 查询原 load_key；可靠 absent 才用原键载入，loaded 复用确认，unknown/临时查询异常保持 uncertain。SIGKILL 实际覆盖载入前、已载入未确认、激活后，恢复及再恢复均只有一次载入、一代任职。 | PASS |
| 释放、撤销、到期与旧代权限 | 授权∩已载入上限∩实时策略；直接SDK同样受控。释放/撤销/到期清空对应当前指针且 generation 不回退，不恢复前任；旧主发布拒绝，缺少可服务主实例的新请求失败。 | PASS |
| 派生任务撤权与迟到拒收 | authorization.ts/policy.ts/requests 保留接收快照与来源；接任保留旧任务，释放/撤权/到期使未完成任务终态失败。A02 实际关闭失败时分支仍 active，但终态/绑定撤权检查阻止候选写入；取消、回收待处理及迟到拒收有断言。 | PASS |
| 单 writer、连接隔离与服务恢复 | 真实 Unix socket 权限0600，多连接共用一个协调器；第二写库入口 WORKSPACE_LOCKED。真实服务进程 SIGKILL 后恢复陈旧自有 socket 并刷新凭据，原绑定保留；活socket、普通文件和symlink不盲删。 | PASS |
| 独立 worker 与到期维护 | service 实际处理 outbox，fixture 回答形成可读 artifact/收件箱，原聊天历史不被注入。阻塞 runTurn 时独立过期维护仍使请求失败并调用 cancel；未确认结果保留 execution_uncertain，不把清理失败当作权限延续理由。 | PASS |
| 最小 MCP 与精确 SDK | 官方SDK 1.32.1、锁文件及 toolchain 记录对应本地依赖/官方元数据；MCP stdio只提供14个会话工具。两个真实MCP子进程消费各自授权，不能签发、冒用或另开写库。 | PASS |
| 通用性及能力缺失诚实失败 | 核心及 service/mcp 无业务角色枚举，custom-role 由数据接入。缺身份/载入能力返回 ADAPTER_CAPABILITY_MISSING；无可靠对账保持 uncertain。Mock/固定回答/进程夹具不被计为真实Harness。 | PASS |

主要实际断言来自 core/test/anchor.test.ts、protocol/test/anchor-schemas.test.ts、service/test/service.test.ts、mcp/test/mcp.test.ts、integration 的 anchor-recovery/service-restart；旧状态、预算、隔离和发布行为继续由完整门禁覆盖。

## 3. 验收方实际运行

运行使用 Node22.23.2；Unix socket/真实子进程验证已获本地自动审批。所有工作空间是临时夹具，不使用真实账户或Harness凭据。

| 验证 | 实际结果 |
| --- | --- |
| 冻结最终专项：`node node_modules/vitest/vitest.mjs run packages/core/test/anchor.test.ts packages/service/test/service.test.ts packages/mcp/test/mcp.test.ts tests/integration/anchor-recovery.process.test.ts tests/integration/service-restart.process.test.ts --reporter=verbose` | **5文件、29测试全部通过，0跳过，207.13秒，实际退出0**：[focused-final.log](evidence/2026-10-14-p5-a-independent/focused-final.log)。 |
| `node .../repro-release-knowledge.mjs` | 退出0；释放尝试保持failed/binding null，原generation1与原实例不变，只有一次载入：[最终日志](evidence/2026-10-14-p5-a-independent/repro-release-knowledge-final.log)。 |
| `node .../repro-release-branch.mjs` | 退出0；请求failed/cleanup_pending1，关闭失败的branch仍active，但候选提交明确PERMISSION_DENIED：[最终日志](evidence/2026-10-14-p5-a-independent/repro-release-branch-final.log)。 |
| `node .../repro-event-order.mjs` | 退出0；相同事件字段顺序改变仍返回原authorization_id：[最终日志](evidence/2026-10-14-p5-a-independent/repro-event-order-final.log)。 |
| `node .../repro-service-expiry.mjs` | 退出0；在pending轮次前确认未过期，按真实expires_at等待跨越到期；授权列表空、请求failed、cancel次数1、execution_uncertain true：[最终日志](evidence/2026-10-14-p5-a-independent/repro-service-expiry-final.log)。 |
| 产品/测试清单定稿校验 | 验收方实际运行，84/52项均成功、退出0，证据见第一节。 |

表中 `...` 统一为 `docs/phase-reports/evidence/2026-10-14-p5-a-independent`，四脚本在专项结束后顺序执行，未与开发方重测试并发。到期脚本最终扩大前置到15秒并按所签发expires_at等待，保留真实时间及终态/取消断言，未改数据库时钟。

另独立读取开发方冻结 [完整 npm run check 日志](evidence/2026-10-14-p5-a/check-final.log)：typecheck→build→Vitest 完整结束，**34文件、372测试全部通过，0跳过，630.23秒**。开发方原工具会话在续转后失效，未取回最终进程退出码；本报告不声称观察到该整轮退出0。早期类型/沙箱/夹具时窗失败和中途基线通过均未替代最终证据。

## 4. 审查问题及关闭证据

| 编号/优先级 | 触发、位置与影响 | 修复要求及最终复验 |
| --- | --- | --- |
| A01/P1（已关闭） | anchor.ts/drive：successor载入await期间release将尝试failed，原主又更新知识；旧知识重准备分支无条件写prepared，复活尝试、二次载入并接任generation2。独立 [脚本](evidence/2026-10-14-p5-a-independent/repro-release-knowledge.mjs) 与 [before日志](evidence/2026-10-14-p5-a-independent/repro-release-knowledge-before.log) 真实显示failed→active/loads2。初次组合shell末尾cat使工具退出码为0，不将它说成原脚本通过。 | 开发方增加每次外部await后的终态重读、非终态更新谓词、catch保护既有failed；冻结独立脚本退出0，旧主/代次与一次载入断言通过，组合回归纳入29专项/372门禁。 |
| A02/P1（已关闭） | authorization.ts/requireDelegatedAuthorizations与policy.ts：发起绑定release后，宿主close失败留下active请求分支；旧检查只看未撤销/未过期授权，仍可通过直接SDK提案。独立 [脚本](evidence/2026-10-14-p5-a-independent/repro-release-branch.mjs) [before日志](evidence/2026-10-14-p5-a-independent/repro-release-branch-before.log) 及退出1证明failed请求仍提交候选。 | 开发方增加请求终态及发起/目标binding状态检查，允许superseded的既有任务但拒绝已释放绑定；冻结脚本实际PERMISSION_DENIED/退出0，清理失败不延续权限。 |
| A03/P1（已关闭，代码审查项） | packages/service/src/index.ts的schedule与authority.tick：整个执行tick的单worker等待任意runTurn时，原定时维护可能一起被阻塞。首轮expiry脚本跨越开发方编译，观察failed但cancel0，不能视为纯旧基线缺陷复现；该 [过渡日志](evidence/2026-10-14-p5-a-independent/repro-service-expiry-before.log) 不计通过。 | 开发方拆分同步过期失效、独立回收维护与执行worker；冻结专项及独立真实到期脚本证明pending轮次期间失败/取消，且不假报不确定执行已结束。 |
| A04/P2（已关闭） | anchor.ts/record：对adapter返回event直接按对象键顺序JSON.stringify，同源同字段值仅换序误报IDEMPOTENCY_CONFLICT。独立 [脚本](evidence/2026-10-14-p5-a-independent/repro-event-order.mjs) [before日志](evidence/2026-10-14-p5-a-independent/repro-event-order-before.log) 实际退出1。 | 开发方按HumanAuthorizationEvent固定字段序列计算hash，能力仍规范化排序；冻结脚本返回原授权、退出0，实际范围改变仍冲突并保留原基线的测试通过。 |

开发方另外修正了临时对账异常误转failed及终态outbox标记问题。验收方只读核对当前实现，并在冻结专项中实际验证暂时查询失败仍uncertain、禁止新键重放；没有将开发方修复声明直接当作关闭证据。当前无未关闭P5-A返工项。

## 5. 保留边界与下一步

本PASS仅覆盖本阶段规定的本地协议、权限、事务、共享服务和进程边界。Mock的人类来源、材料确认、固定回答与持久fixture不能证明真实聊天消费知识或模型协作；MCP bearer认证也不能证明授权来自真人。

**G01仍BLOCKED**：P5-H需用户指定并授权真实Harness名称/版本、官方支持接口、当前聊天身份、人类事件来源、材料确认方式及允许的账户/任务范围。P5整体与v0.1原型不能改为PASS；GUI、跨平台打包及发布仍未交付。本轮止于P5-A，不自动选择真实宿主、不进入后续阶段，也不授予合并或远程发布权限。
