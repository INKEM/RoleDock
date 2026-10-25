# P5-H 开发报告：ZCode 真实接入与受限能力

日期：2026-10-14  
状态：**待独立验收**  
独立验收定稿：**P5-H BLOCKED；受限诊断实现的本地边界验证通过**，见[独立报告](P5-H-review.md)。上行保留开发提交时的流程状态。  
开发结果：可运行的ZCode受限诊断接入已交付；完整P5-H闭环候选结论为 **BLOCKED**，G01未关闭。不是Harness完整接入PASS。

## 1. 授权、基线与环境

用户已明确指定ZCode并要求开始执行P5-H。前置P5-A独立PASS有效。本轮只使用当前已配置账户/模型及新建专用诊断会话，没有使用旧P0会话或私人项目聊天，没有修改全局ZCode配置、桌面安装包或账户文件；未进入GUI/发布。

基线为HEAD `a083874e60e7a40d88a18e075b699b1fb818b0e1`加保留的用户P5/P5-R/P5-A未提交工作，再叠加本轮变更；没有重置、提交或推送。整体diff不能全部归为P5-H。见[初始状态](evidence/2026-10-14-p5-h/baseline-status.txt)。

最终89产品/配置文件由[implementation.sha256](evidence/2026-10-14-p5-h/implementation.sha256)固定，清单摘要`304dabb2f9bed0ba128e078eea6851cba0211eda8555c83abeb2742d6a15871e`；55测试/夹具文件由[tests.sha256](evidence/2026-10-14-p5-h/tests.sha256)固定，摘要`20404d34a6721038622cbeb5d285eaf508c8186163bd4ff3f933e4db0e4b2b08`。包含既有实现，排除dist；产品/测试在全量门禁开始前冻结。定稿工作区见[final-worktree-status.txt](evidence/2026-10-14-p5-h/final-worktree-status.txt)。

| 组件 | 实际版本/证据 |
| --- | --- |
| RoleDock环境 | Node22.23.2、npm10.9.8；不升级工具链 |
| ZCode Desktop | 安装包package.json的3.15.3；`/usr/bin/zcode`指向桌面Electron，不能代作CLI入口 |
| Bundled CLI | `/opt/ZCode/resources/glm/zcode.cjs`现场`--version`为0.16.9；[doctor](evidence/2026-10-14-p5-h/zcode-doctor.json)、[help](evidence/2026-10-14-p5-h/zcode-help.txt) |
| Runtime包装元数据 | 同bundle内native包装标签0.13.3，不能与CLI/Desktop版本混同 |
| 已有MCP连接器 | zcode-delegation0.1.0，当前用户已有配置；它不是官方ZCode SDK。文件路径/哈希见[组件清单](evidence/2026-10-14-p5-h/host-components.sha256) |
| 实际模型 | GLM-5.3，provider account:bigmodel-team-coding-plan，reasoning low；[诊断摘要](evidence/2026-10-14-p5-h/real-session-summary.json) |
| 新增包 | @roledock/adapter-zcode0.1.0-alpha.0（private）；复用官方MCP SDK精确1.32.1和锁文件，不复制账户实现/凭据，不直接调用模型API |

官方接口依据为[CLI源码入口](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/run.ts)、[Hooks](https://zcode.z.ai/en/docs/hooks)、[MCP](https://zcode.z.ai/en/docs/mcp-services)；本机bundle及连接器另现场核查。没有依照非官方逆向文档猜参数或向桌面私人接口注入消息。

## 2. 实施与诚实能力边界

新增[ADR-0010](../adr/0010-zcode-restricted-integration.md)、`adapters/zcode`可运行适配器、MCP连接器客户端、诊断命令、13个适配边界测试及1个真实子进程清理测试。文档/工具链已同步，详见[接入说明](../zcode-integration.md)。核心/协议行为未修改；只添加构建引用和精确工作区依赖。

`getCapabilities()`明确restricted，四项隔离均false，external能力均false；cancel/nativeResume/nativeFork不声明。任何bootstrap、capability_scope、temp_dir输入在宿主调用前NOT_IMPLEMENTED；外部登记/锚定缺能力明确拒绝。裸诊断会话的成功不能经SDK变成角色任职。

本地SQLite journal在创建/发送前写intent，保存已确认host映射和执行指纹；丢确认、字段异常或连接中断保留uncertain，重启不盲建/重发。按创建键查询只恢复本地确认记录，未知intent明确不返回absent。宿主没有创建/执行幂等保证的窗口仍是缺口。

答案只采用确认accepted后的受控轮次：发送前marker之后连续完整事件、只有一个started/terminal、实际idle及一致正文。旧答案、多个轮次、错会话、事件/文字截断不成为completed。仍不宣称宿主execution_key或可靠大窗口对账支持。

closeSession明确NOT_IMPLEMENTED，不删除host历史或journal来冒充关闭。MCP传输在Linux创建自有进程组，断开清理该组；不操作原桌面或其他会话。适配器初始化失败也进入finally断开；journal句柄失败路径关闭。**进程断开不等于远端模型取消或持久会话回收**。

诊断预算只限制新发送轮次/期限及实际答案接纳，不能在模型内部支出前限制生成token/字节；超限拒收不代表模型已停止。提示词“不要用工具”不是权限保证。

## 3. 实际验证

所有RoleDock测试工作空间为临时夹具。真实模型证据独立列出，不纳入fixture通过数量；没有skip。模型使用当前已有配置，不保存凭据/私人原文。新建的诊断宿主持久记录仍保留，因为没有可靠关闭接口。

| 验证/命令 | 实际结果及采用方式 |
| --- | --- |
| `node .../zcode.cjs --version/--help/doctor --json` | 实际exit0，CLI0.16.9在Node22运行；组件hash固定，未升级运行时。 |
| 现有连接器连通性探针 | 新专用会话sess_fdc86a73-f315-4690-94b6-fee5a6a37bed获得真实GLM-5.3中文答案；仅早期连接探针，不用作角色工作证据。 |
| 适配器诊断命令 | 专用工作空间`/tmp/roledock-p5h-live`，新会话`sess_82f33699-e70d-40f2-9d62-018b7d11f56e`；实际exit0，正文“ZCode真实模型可达”，23UTF-8字节、完成轮次1：[real-probe-first.log](evidence/2026-10-14-p5-h/real-probe-first.log)。没有角色材料/授权/请求artifact。 |
| 同journal重启诊断 | 实际exit0，返回同session/key的confirmed-prior-answer，代码不再次send：[real-probe-restart.log](evidence/2026-10-14-p5-h/real-probe-restart.log)。独立读取该专用会话持久messages，只有1个user_prompt；答案模型/消息ID/token用量及来源反例选择字段保存为[摘要](evidence/2026-10-14-p5-h/real-session-summary.json)，不复制synthetic系统提示。 |
| 初始类型检查 | 实際注册表无BUDGET_EXCEEDED，改用既有INVALID_STATE_TRANSITION；初轮错误日志保留[typecheck-initial.log](evidence/2026-10-14-p5-h/typecheck-initial.log)。第二/三/四轮均exit0，最后产品修复后为[typecheck-fourth.log](evidence/2026-10-14-p5-h/typecheck-fourth.log)。 |
| 适配专项迭代 | 初轮11通过/2失败（source/dist测试WeakMap混用），后续12/13通过（夹具误以为executeRequest返回failed而非拒绝、表名及终态断言错误）；均保留restricted-first/second/third/final-candidate日志，不计整轮成功。 |
| 适配专项最终候选 | 13/13通过、0跳过、20.90秒、实际exit0：[restricted-final.log](evidence/2026-10-14-p5-h/restricted-final.log)。随后独立审查补初始化资源清理，最终证据以全量门禁为准。 |
| 初始化失败清理 | SDK已连接后journal路径不可用；正常本地环境1测试通过、实际exit0、314ms：[cleanup-local.log](evidence/2026-10-14-p5-h/cleanup-local.log)。确认自有connector及grandchild停止，不暴露stderr，原文件不改。sandbox子进程stdin受限导致15s超时的focused-final/cleanup-debug日志保留，不能作通过；真实本地运行修复证据不使用模型。 |
| `npm ci --ignore-scripts --offline` | 精确安装144packages、audit153packages、0漏洞；全量门禁前安装成功：[npm-ci.log](evidence/2026-10-14-p5-h/npm-ci.log)。 |
| 冻结完整 `npm run check` | **typecheck→build→Vitest完整结束，36文件/386测试全部通过，0跳过，360.03秒，实际exit0**：[check-final.log](evidence/2026-10-14-p5-h/check-final.log)、[持久退出码](evidence/2026-10-14-p5-h/check-final-exit.txt)。未使用旧372通过替代本轮基线；运行期间产品/测试冻结。 |
| 最终源码/测试/宿主组件校验 | 89产品、55测试及宿主组件清单均逐项校验成功、实际exit0；[产品](evidence/2026-10-14-p5-h/implementation-check.log)、[测试](evidence/2026-10-14-p5-h/tests-check.log)、[宿主](evidence/2026-10-14-p5-h/host-components-check.log)。git diff --check亦exit0。 |
| 独立最终专项 | **2文件14测试全部通过，0跳过，24.57秒，实际exit0**；89产品/55测试/2宿主组件清单由验收方独立核验exit0，见[独立报告](P5-H-review.md)。没有重发真实模型或访问其他聊天。 |

13适配边界测试包含本地确认恢复、不确定创建/发送重启禁止重放、材料/scope输入零宿主调用、旧/缺口/多轮/截断/错host答案拒收、预算和未实现close。10个重叠**fixture RoleDock请求**的实际执行尝试均ADAPTER_CAPABILITY_MISSING，失败、0轮次/0artifact/0完成outbox；不是10个真实模型隔离请求完成。旧Mock/bridge共享完整适配契约仍随门禁回归；ZCode尚不能通过要求host载入/cancel/close的完整套件，不跳过后宣称通过。

## 4. P5-H退出条件与G01剩余缺口

| 编号 | 条件/证据 | 当前状态与所需输入 |
| --- | --- | --- |
| H00 | 用户指定及授权宿主、实际版本、模型连通性 | 已补齐宿主选择和受限诊断；ZCode/连接器/模型版本及真实答案已记录。不能单凭选择关闭G01。 |
| G01-Z01 | 真人在现有ZCode会话授权 | **BLOCKED**。实际程序消息client_id=legacy-session-send却origin=realUser、semantics=real_user，证明标签不能作为人类凭证；UserPromptSubmit走同输入链。需要ZCode受支持且可认证的人类提交来源/接入身份，普通模型/工具不能伪造。owner-selection仅为本地降级，不能替代此验收条件。 |
| G01-Z02 | 原会话完整材料消费/确认后Agent显式锚定 | **BLOCKED**。连接器没有材料确认/原会话实时接入方法；Hook存在24000字符截断及await时序风险。需要支持完整payload/哈希/版本/载入键确认与对账的官方接入组件。 |
| G01-Z03 | 正式角色动作、继承、旧主撤权与独立请求隔离 | **BLOCKED**。未证明上下文、临时写入、结果、能力四项隔离；实际元数据仍列Bash/Write/Agent等内置工具，不能从plan标签或提示词推断硬限制。需要验证限制覆盖插件/全局MCP及嵌套工具、请求专用工作区和结果归属。10个真实重叠请求、artifact/inbox采纳与真实迁移均未执行为成功。 |
| G01-Z04 | 副作用对账、取消/关闭与支出前预算 | **BLOCKED**。没有可靠创建/发送幂等键及可调用cancel/close；本地journal不能补齐宿主未知窗口。需要受支持的持久唯一键/结果查询和资源控制接口，以及明确可执行的预算。当前只保留unknown/拒收迟到，不假报已停止。 |

上述缺口来自所选宿主/当前连接器的可证明接口不足，不是再运行Mock可以补齐的证据。未猜测私有API、改宿主源码或新增自建聊天Harness。缺口关闭前P5-H、P5整体与v0.1均不能宣称PASS。

## 5. 独立验收与后续

独立Agent已审查P5-A前置、官方资料、本机schema和受限实现，并发现初始化失败跳过connector清理的P2问题；开发方修复、加入真实fixture子进程回归。最终产品/测试清单和完整门禁将提交给独立Agent，正式报告为P5-H-review.md，不能以本开发报告取代验收。

完成本地可交付部分后止于P5-H。下一步是补齐上表ZCode受支持接入能力并复验真实闭环；本轮不进入P6-G或发布，不修改此前P5-A PASS历史证据。
