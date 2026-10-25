# P5-H 独立验收：ZCode 受限接入与真实闭环缺口

日期：2026-10-14  
验收方：独立 Codex 验收 Agent；未修改产品实现、未发送模型任务  
结论：**P5-H BLOCKED；ZCode 受限诊断实现的本地边界验证通过；P5 整体 G01 未关闭**

## 1. 范围、前置与冻结基线

已读取 AGENTS、开发蓝图、工具链、桌面计划、ADR-0007/0009/0010、COMMON、REVIEW、05-H 提示词、P0–P5 复验及 P5-R/P5-A 独立 PASS 前置，并检查最终 [P5-H 开发报告](P5-H-development.md)、新适配器、连接器客户端、诊断入口、测试、官方资料与实际执行日志。未将开发报告的完成声明视为验收结论。

基线为 HEAD `a083874e60e7a40d88a18e075b699b1fb818b0e1` 加用户既有 P5/P5-R/P5-A 未提交工作和本轮增量；未重置、提交、推送或发布。整体工作区差异不能全部归因于 P5-H。产品冻结清单 [implementation.sha256](evidence/2026-10-14-p5-h/implementation.sha256) 的89项与摘要 `304dabb2f9bed0ba128e078eea6851cba0211eda8555c83abeb2742d6a15871e`、测试清单 [tests.sha256](evidence/2026-10-14-p5-h/tests.sha256) 的55项与摘要 `20404d34a6721038622cbeb5d285eaf508c8186163bd4ff3f933e4db0e4b2b08` 均由验收方实际逐文件核验，退出0；宿主 bundle 与连接器两项清单也实际核验退出0。证据见 [产品校验](evidence/2026-10-14-p5-h-independent/implementation-check.log)、[测试校验](evidence/2026-10-14-p5-h-independent/tests-check.log)、[宿主校验](evidence/2026-10-14-p5-h-independent/host-components-check.log)。清单排除构建输出，包含既有阶段实现。

验收方只增加本报告和独立验证证据。专项不与开发方全量门禁并发，不使用真实账户、其他项目聊天或私人历史，不新增 ZCode 模型执行。

## 2. 已交付部分的独立检查

| 条件 | 实际行为与证据 | 判定 |
| --- | --- | --- |
| 已授权宿主与精确版本 | 用户明确指定 ZCode；本机 Desktop 3.15.3、CLI 0.16.9、runtime 包装标签0.13.3分别记录；doctor日志实际为 Node22.23.2/CLI0.16.9。zcode-delegation0.1.0是已有连接器，未冒称官方SDK；MCP SDK直接依赖精确1.32.1并有锁文件。 | 已满足接入选择和版本记录 |
| 可运行且诚实受限 | adapters/zcode/src/index.ts 明确 level=restricted，四项 isolation 和四项 external 均false，cancel/nativeResume/nativeFork均false。constructor/journal、MCP transport、诊断bin为实际实现，未创建不可运行完整接入空壳。 | 本地通过 |
| 材料/权限输入不能假成功 | bootstrap、capability_scope（包括空数组）、temp_dir 在任何宿主创建前 NOT_IMPLEMENTED；hash篡改先VALIDATION_FAILED。核心外部登记缺能力拒绝，SDK首代不能获得角色实例/主指针，generation仍0。 | 本地通过；零宿主调用 |
| 请求隔离不足先拒绝 | 10个已接收fixture RoleDock请求实际重叠执行尝试均 ADAPTER_CAPABILITY_MISSING；记录全部failed且error_json.code为ADAPTER_CAPABILITY_MISSING，0宿主调用、0预留轮次、0artifact、0完成outbox。测试不把这些拒绝说成10个真实模型隔离成功。 | 本地安全拒绝通过；真实隔离未验证 |
| 已确认创建与恢复 | 同创建键重叠共用一次RPC；本地确认映射重启后返回同host。journal固定workspace、校验handle归属，不以自报host_id转用会话。 | 本地通过 |
| 创建/发送未知不盲重放 | 外部动作前保存intent；丢回执跨重启仍uncertain。未知创建查询不能返回absent；未知send即使出现回答仍不能采纳或重发。宿主幂等缺口没有被本地journal掩盖。 | 本地通过；宿主未知窗口仍BLOCKED |
| 诊断答案与执行归属 | 必须确认accepted，再从发送前marker之后累计完整连续事件，仅一个started/terminal，host idle、终态和正文一致才completed。实际正文入journal，同键不再send，不同输入冲突。旧答案、序号缺口、多轮、文字截断和错host均不成为completed。 | 本地通过；完整宿主对账未验证 |
| 诊断预算边界 | 发送前校验期限和轮次，结果接纳校验期限/实际UTF-8字节。超输出拒收、未实现host close明确失败；文档明确这些规则不限制模型内部生成token/字节支出，不保证停止执行。 | 本地行为通过；完整预算/取消未验证 |
| 进程与初始化失败清理 | transport只启动/清理自有进程组，不转发可能敏感的stderr。bin将适配器构造也纳入finally，journal close失败仍disconnect。真实fixture连接后故意使state-dir为文件，实际退出1且文件保留，自有connector及grandchild均停止。 | 修复后本地通过 |
| 核心通用性与旧门禁 | 新宿主代码在adapter目录，core/protocol无ZCode执行依赖；角色仍为包数据。全量构建、类型检查及旧Mock/bridge/核心/CLI/MCP回归实际完成。 | 本地回归通过 |

`lookup_session_by_creation_key=true`仅表示这份固定journal能够恢复本地已确认映射；不是宿主提供原生幂等创建。当前未知intent抛uncertain的实现与文档限制一致。关闭连接器进程也不是 ZCode 持久会话回收或远端模型取消证据。

## 3. 实际验证和证据采用

验收方在正常Linux本地环境、Node22.23.2运行以下专项，真实子进程夹具通过自动审批，不读取账户、不运行模型：

```text
node node_modules/vitest/vitest.mjs run adapters/zcode/test/zcode-adapter.test.ts tests/integration/zcode-diagnostic-cleanup.process.test.ts --reporter=verbose
```

**2文件、14测试全部通过，0跳过，24.57秒，实际退出0**：[focused-final.log](evidence/2026-10-14-p5-h-independent/focused-final.log)。13项适配测试与1项真实子进程清理测试覆盖第二节行为。失败路径有状态/次数/进程存活断言，不是仅复述能力字符串。

另独立阅读开发方冻结 [完整门禁日志](evidence/2026-10-14-p5-h/check-final.log) 及 [持久退出码](evidence/2026-10-14-p5-h/check-final-exit.txt)：`npm run check` 的 typecheck→build→Vitest完整结束，**36文件、386测试全部通过，0跳过，360.03秒，退出码记录为0**。精确锁安装、audit0和此前失败日志均已保留；没有将失败的专项迭代、沙箱stdin超时或旧372项门禁替代本轮最终证据。验收方未再执行整套门禁。

真实模型证据由开发方集中执行，验收方只读日志和安全摘要，不重复发送：

- [首轮诊断](evidence/2026-10-14-p5-h/real-probe-first.log) 记录专用会话 `sess_82f33699-e70d-40f2-9d62-018b7d11f56e` 的真实回答“ZCode真实模型可达”，23 UTF-8字节、完成轮次1。只有连通性诊断，没有角色授权/载入/请求artifact。
- [重启诊断](evidence/2026-10-14-p5-h/real-probe-restart.log) 返回相同host/key的confirmed-prior-answer；[专用会话摘要](evidence/2026-10-14-p5-h/real-session-summary.json) 记录只有1个user_prompt及GLM-5.3/provider/用量字段，支持没有新增模型轮次。旧私人会话不在验收范围。
- 程序输入实际 `client_id=legacy-session-send` 却标为 `origin=realUser`、`semantics_origin=real_user`；这构成人类来源标签不能作为授权凭证的实测反例。摘要的工具元数据列出Bash/Write/Agent，不能从plan标签或“不要使用工具”提示推断硬隔离；未据此宣称这些工具实际被执行。
- 两次日志均明确host-cleanup NOT_IMPLEMENTED；持久诊断会话仍存在。模型诊断执行早于初始化清理修复，采用范围仅为未变的连通性/答案与确认记录恢复行为，不能替代冻结源码后的清理验证。

## 4. 问题与尚未满足的退出条件

### H-R01 — P2，初始化失败跳过连接器回收（已关闭）

触发：MCP连接成功后，journal路径不可写、不是目录或被持锁，new ZCodeAdapter抛错。原 bin.ts 在构造后才进入try/finally，无法执行disconnect，可能遗留自有connector/app-server。独立代码审查指出该路径；开发方将构造纳入清理范围、嵌套finally保证journal close失败仍disconnect，并关闭构造期间SQLite异常句柄。冻结专项中的真实fixture进程测试实际通过，确认connector及grandchild停止、失败退出1、原文件保持、敏感stderr没有泄漏。该关闭证据证明本地进程清理，不能算host close支持。

### G01-Z01 — P1，真人授权来源与当前会话身份（BLOCKED）

位置：当前zcode-delegation输入面、ZCode UserPromptSubmit/legacy session-send链；adapter.external.current_session_identity/human_authorization_events=false。

触发/影响：程序发送的内容也走UserPromptSubmit并被标realUser，普通Agent转述或工具消息不能据这些字段获得人类授权。没有经认证的既有桌面会话接入身份，因此P5-H要求的真人在原会话授权未完成。

所需输入与复验：ZCode受支持的受信入口认证当前会话和人类提交来源；证明程序/模型/文档输入不签发授权，跨会话消费拒绝，再由该会话Agent真实调用显式锚定。所有者owner-selection降级应单独标注，不能替代本条件。

### G01-Z02 — P1，原会话完整材料载入和确认（BLOCKED）

位置：当前连接器缺load/lookup-load方法，adapter.external.load_materials/reconcile_load=false。本机Hook生命周期context存在24,000字符截断；锚定工具内部等待载入还需处理当前运行轮次的时序。

触发/影响：只提供bundle ID/hash、模型复述或发送另一诊断聊天不能证明原会话实际消费完整固定契约与知识。当前角色工作、交接和首个正式轮次前确认没有证据。

所需输入与复验：完整payload、载入键、hash/version确认及可靠查询接口；实测原聊天完整消费材料后才激活，确认丢失可对账、撤权/知识变化拒绝或重新准备，不复制私人历史。官方 [Hooks](https://zcode.z.ai/en/docs/hooks) 说明生命周期上下文入口，不能自动证明这个版本具备本项目的完整载入契约。

### G01-Z03 — P1，独立请求四项隔离和真实角色闭环（BLOCKED）

位置：adapter.isolation四项false，ZCode内置/全局/插件MCP及嵌套工具作用域缺实证。

触发/影响：plan模式或提示词不等于权限执行；当前核心因此拒绝RoleDock请求。没有真实正式发布、接任、旧主发布拒绝、10个真实重叠请求、结果artifact/收件箱采纳或跨Harness语义迁移的成功证据。

所需输入与复验：宿主可执行工具/临时工作区/上下文/结果归属限制，范围覆盖MCP、插件和嵌套工具；再实际运行完整角色链及10个重叠请求，核对正文/哈希、代次、收件箱、主聊天不注入和私人历史不迁移。官方 [MCP](https://zcode.z.ai/en/docs/mcp-services) 证明工具配置/传输方式，不能自动证明上述隔离。

### G01-Z04 — P1，不确定副作用、资源控制和支出前预算（BLOCKED）

位置：当前连接器未提供可靠host创建/输入幂等键或可调用cancel/close；adapter.closeSession明确NOT_IMPLEMENTED。

触发/影响：RPC被宿主受理但确认丢失时，本地journal只能保留unknown，无法证明宿主未创建/未执行；没有保证已开始模型运行停止或持久会话回收的接口。诊断结果拒收不等于预算在支出前执行。

所需输入与复验：受支持的持久唯一键及查询、取消/关闭和明确预算执行接口；实测受理后进程退出与恢复不重复副作用，取消/期限后终态不复活、不接纳迟到答案，预算限制在产生对应支出前执行。官方 [CLI入口源码](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/run.ts) 的app-server入口和本机bundle存在底层方法，不自动等于现有连接器已满足这些接入能力。

## 5. 原P5条件与阶段结论

Mock和真实进程bridge既有适用一致性套件、通用示例、CLI JSON与迁移状态回归随386项门禁通过；这些仍是原P5的本地条件。ZCode受限拒绝专项没有通过要求角色bootstrap/cancel/close的完整适配套件，不能把未运行或缺能力的项当PASS。

原P5必需的至少一个真实Harness角色载入→继承→独立请求仍未完成；用户指定ZCode解决了宿主选择，真实诊断解决了模型连通性，四项能力/证据缺口继续使G01 BLOCKED。因此**本轮没有P5-H PASS，也没有P5整体或v0.1原型PASS**。P5-A/P5-R本地PASS前置保持，不以新阶段缺口追溯否定其已验收范围。

当前没有未关闭的本轮本地产品返工项。下一步须补齐G01-Z01至Z04的ZCode受支持接入组件/接口，并对真实闭环独立复验；不能仅重复模型连通性诊断或Mock测试关闭缺口。本轮止于P5-H，不进入GUI、打包发布或远程操作。
