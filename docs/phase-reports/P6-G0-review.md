# P6-G0 独立验收：技术探针与 GUI 操作契约

最新裁定：见 [P6-G0-final-review.md](P6-G0-final-review.md)，本次返工最终独立复验 **PASS**，R01–R04 全部关闭；下文保留首轮历史。

日期：2026-10-26（独立验证于 2026-10-25 晚启动）

本次返工复验见 [P6-G0-rework-review.md](P6-G0-rework-review.md)：仍为 **REWORK**，R02/R04 已关闭，R01/R03 未完全关闭。以下保留首轮验收原文。

结论：**REWORK**。Electron／独立 Node／SQLite／MCP／打包技术路径已独立复现通过；GUI 契约存在 R01–R03 三项未闭合的必需内容，ADR 还提前宣称验收通过（R04）。修复后复验 G0，**当前不能进入 G1**。

## 1. 范围、依据与实际基线

- 依据：AGENTS、开发蓝图、桌面计划 §4/§5/§8、toolchain、`prompts/COMMON.md`、`prompts/REVIEW.md`、`prompts/06G0-contract-and-spike.md`。
- 被验收报告：[P6-G0-development.md](P6-G0-development.md)。前置 B5-4 和 G-min 独立验收 PASS 已核对；本轮不重开 P5 验收。
- 基线：HEAD `d9743365256459a773a5319791cf3b7bb2e5fbe7` + 当前 G0 未提交工作区。既有计划重编改动和本次 G0 交付都保留，没有提交或回滚用户改动。
- 验收分工：主验收 Agent 检查源码、运行类型／专项／窗口／打包验证；另一独立审查 Agent 只读检查契约、版本与依赖。开发报告不作为通过依据。
- 本轮未修改产品实现或被审查契约，只新增本报告、独立证据和复现材料。源码／契约／配置基线 29 文件哈希验证前后无变化，见 [baseline.sha256](evidence/2026-10-25-p6-g0-independent/baseline.sha256)。

## 2. 独立执行的验证

所有运行采用 Node 22.23.2、npm 10.9.8；Electron 窗口在当前 Linux DISPLAY=:0 上运行。实际进程、Unix socket 和窗口测试在已获自动审批的沙箱外执行，仅使用临时 mock 工作空间，无真实模型任务、账户操作、系统安装或发布。

| 命令／检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `timeout 240s npm run typecheck` | exit 0；`tsc -b --force` 与全量 noEmit 均通过 | [typecheck.log](evidence/2026-10-25-p6-g0-independent/typecheck.log) |
| `npx vitest run packages/desktop/test/desktop.test.ts packages/desktop/test/probe-contract.test.ts packages/service/test/service.test.ts packages/mcp/test/mcp.test.ts` | **4 文件、15 测试全部通过，exit 0** | [focused.log](evidence/2026-10-25-p6-g0-independent/focused.log) |
| `npm run desktop:build` | exit 0；从当前源码重建 5 个 bundle 与 Schema 资源 | [build.log](evidence/2026-10-25-p6-g0-independent/build.log) |
| `npx playwright test --config packages/desktop/playwright.config.ts` | **1 项真实 Electron E2E 通过，exit 0，8.0 秒**；具名 IPC、无 renderer Node、服务启动、四项检查、目录 fixture 回读、关窗留服务、同 userData 单实例、退出回收和锁释放均有断言 | [e2e.log](evidence/2026-10-25-p6-g0-independent/e2e.log) |
| `npx electron-builder --linux dir --publish never` | exit 0；独立重建 linux-unpacked，无安装或发布 | [package-dir.log](evidence/2026-10-25-p6-g0-independent/package-dir.log) |
| `linux-unpacked/roledock-desktop-probe --selfcheck` | exit 0、`mode=packaged`、四项 pass；固定资源 Node **v22.23.2**，第二连接 SQLITE_BUSY errcode=5，MCP 14 工具 + authorizations.get 成功 | [packaged-selfcheck.log](evidence/2026-10-25-p6-g0-independent/packaged-selfcheck.log) |
| 独立打包窗口脚本，cwd 为 `/tmp`，不提供 dev runtime 环境变量 | exit 0；实际窗口四项检查全通过；webPreferences 为 nodeIntegration=false、contextIsolation=true、sandbox=true；退出后自有 service PID 消失 | [windows.log](evidence/2026-10-25-p6-g0-independent/windows.log)、[截图](evidence/2026-10-25-p6-g0-independent/packaged-window.png) |
| 无 dialog fixture 打开原生目录对话框 | X11 中观察到本次 `RoleDock 探针：选择目录` 原生窗口；该次没有启动 service，关闭了自有探针进程 | 同上 windows.log |
| 纯函数／Schema 专项反例 | 复现公开授权 ID 被删除、自由文本标记保留、取消状态名不匹配 | [repro-contract.log](evidence/2026-10-25-p6-g0-independent/repro-contract.log) |
| 依赖和锁文件核对 | 5 个直接 devDependencies 精确固定且与 lock 一致，engines 兼容 Node 22.23.2；服务使用独立锁定 Node 的边界明确 | package.json、package-lock、toolchain 静态核验 |

本轮没有重跑 `npm ci` 或完整 `npm run check`；开发方的 **43 文件／460 测试**全通过日志已读取，仅记录为开发证据，不写成验收方重新跑过。针对本次新增 desktop、bundle、IPC、service/MCP 依赖链选择以上独立验证，未发现这些路径的运行失败。

原生目录的**真实点选并回传选中路径仍未采集**：本轮只证明原生窗口打开；路径回传的自动化使用明确记录的 fixture。`.deb` 安装／升级／卸载亦未验证，按原 G0/G7 范围留到后续，不把它们计为本轮成功项。

## 3. G0 条件逐项核验

| 提示词／计划条件 | 文件／实际行为 | 判定 |
| --- | --- | --- |
| 冻结 HEAD/工作区，已有／缺失／计划能力可区分 | 开发基线、契约 §1 与当前 service/mcp 实现相符；admin.events 未被冒称订阅 | 满足 |
| 一套可运行桌面技术探针 | Electron 44.9.3 + 无框架 TS + esbuild，独立窗口和打包产物均运行 | 满足 |
| 服务固定 Node、SQLite、MCP 子进程 | 打包真实窗口和自检分别验证，非 Electron 内置 Node | 满足 |
| 目录选择路径技术验证 | 原生对话框打开、fixture 路径回传可运行；真实点选边界如实保留 | 技术探针成立，完整交互仍未验证 |
| 渲染层无凭据／任意 RPC | 当前五个具名方法、实际 renderer 无 Node、隔离配置与现有返回投影成立 | 当前探针满足；推广脱敏契约有 R01 |
| owner 读模型／可见性／管理取消／候选／幂等定档 | 有 16 项草案和身份面区分，但状态错误、读模型缺项、脱敏冲突 | **未满足：R01–R03** |
| 单 writer 与基本生命周期实测 | 第二连接锁失败、关窗留服务、退出回收、相同 userData 二次启动拒绝的实际 E2E 通过 | 满足已声明探针路径；完整产品恢复属 G1 |
| 版本固定、toolchain 与 ADR | 版本和 lock 一致，定档有证据；ADR 自行写为独立验收通过 | 版本满足；**R04 需修正** |
| 只做 G0、Mock 不冒充真实 Harness | 仅单页探针，G-min 未重写，未发送真实模型任务 | 满足 |

## 4. 必须返工

### R01 — [P2] 脱敏规则删除业务标识，同时未兑现自由文本脱敏承诺

**位置**：[desktop-gui-contract.md:53](../spec/desktop-gui-contract.md)、同文 §4；[bridge.ts:31](../../packages/desktop/src/probe/shared/bridge.ts)。

**触发与证据**：按契约将授权视图统一交给现有 `redact()`，`authorization_id` 和整块 `active_authorization` 因键名正则含 authorization 被删；`body/message` 中的 `Authorization: Bearer SYNTHETIC_SENTINEL_NOT_A_CREDENTIAL` 则原样保留。纯函数复现只用合成标记，没有真实凭据，见 repro-contract.log。

**影响**：后续授权进度、关联与撤销界面可能拿不到必要 ID；契约 §3“键名或值均脱敏、与探针同规则”和 §4“所有 IPC 统一使用该函数”互不自洽。**本问题不声称当前五方法探针已向页面泄露真实 bearer。**

**修复要求**：先定档按资源／字段投影的规则，明确允许的公开 `authorization_id`、授权摘要、文档键等业务字段；秘密凭据字段不得进入 renderer。自由文本中的疑似秘密、错误消息、原始正文、显示投影与内容哈希分别定义，不声称正则能证明任意文本没有秘密，也不将脱敏后的显示正文冒充原内容哈希对应字节。探针辅助函数与文档声明应保持一致；产品 DTO 无须在 G0 全部实现。

**复验**：合成授权 DTO 保留公开关联 ID，秘密字段被拒绝／省略；body/message 的显示策略与文档一致；当前 probe/E2E 继续通过。对应测试不能仅断言所有 authorization 字样消失。

### R02 — [P2] owner 管理取消使用不存在的请求状态，状态与回收约束未闭合

**位置**：[desktop-gui-contract.md:88](../spec/desktop-gui-contract.md)，对照 collaboration-request Schema 和现有 requests.cancel 语义。

**触发与证据**：契约只允许 `awaiting/running`，协议实际枚举为 accepted、queued、running、**awaiting_input**、completed、failed、cancelled、expired；`awaiting` 不存在，见 repro-contract.log。accepted/queued 的管理停止、终态重放和取消能力不足时的结果也没有说明。

**影响**：实现者无法按定档契约实现完整取消矩阵；“取消结果照常走收件箱归并”又没有说明状态通知与正式产物的区别，可能误把取消当作可采纳结果。

**修复要求**：明确每个实际状态的允许／拒绝／幂等行为；同键重放与不同键取消分别说明。规定运行中取消能力不足、请求终态已生效而宿主尚未确认、cleanup_pending/execution_uncertain、迟到答案拒收的关系。owner 管理取消保留独立审计，不借用发起 session；通知不能形成假的正式答案或发布权限。

**复验**：契约矩阵覆盖现有全部状态，无 awaiting 别名；逐项有确定返回／错误和资源状态。G0 不要求实现 G6 控制操作，但不能把其关键状态留给未来猜测。

### R03 — [P2] 页面必需查询没有完整的具名操作／输出映射

**位置**：[desktop-gui-contract.md:34](../spec/desktop-gui-contract.md)–§2 表尾；对照桌面计划 §5/§6/§8、G5/G6 退出条件。

**触发**：按表实现后，文档历史页面没有修订发现／分页契约，checkpoint 摘要与待办没有明确读入口，候选只能看来源／基线／状态而没有正文比较定义；owner 产物 bytes／哈希虽在可见性表获允许，操作表没有清晰的获取契约，`requests.get` 只概括为“产物”。runtime 健康／受管验证、清理进度也只有概要字段，未与页面动作对应。

**影响**：G0 要求的“页面不依赖不存在 RPC、操作映射与可见性完整”尚未满足。后续仍需临时发明接口、查询数据库或混用会话身份才能补页面。

**修复要求**：可扩充现有条目或增加具名操作，无须追求固定 16 项数量；逐一给出角色详情／职责、修订列表、checkpoint 摘要／待办、候选正文／基线、产物内容／哈希、runtime／cleanup 的主体、输入过滤／分页、最小输出字段、可见性和目标阶段。明确这些操作未实施、实现阶段先补 Schema。若选择放弃某个首版页面行为，必须同步修改计划并解释范围变化，不能静默遗漏。

**复验**：逐项从五页面动作查到唯一的现有或待实施操作，公开的只读 DTO 能支持该动作；尤其不要求 owner 冒充角色、不依赖自由 SQL 或 objectPath，不将原文权限被隐藏的资源经候选／产物接口重新暴露。

### R04 — [P2，流程] ADR 提前宣称独立验收通过

**位置**：[ADR-0013:5](../adr/0013-desktop-orchestration-and-owner-views.md)。

**触发**：ADR 状态写“P6-G0 技术验证与契约验收通过”，但开发报告仍为“待独立验收”，本报告才是第一次该阶段独立裁定。

**影响**：后续 Agent 可能误以为 G0 已通过并进入 G1，违反阶段门与验收证据要求。

**修复要求**：改为开发方候选定档／技术验证完成、待独立验收，附本报告状态；只有独立复验真正 PASS 后才更新为已验收。定档技术选择本身不因本项被否定。

**复验**：ADR、开发报告和计划入口不再宣称本阶段已经独立 PASS；保留本轮 REWORK 历史，复验报告引用实际新基线。

## 5. 不阻塞 G0 的边界与 G1 输入

- 原生真实点选回读、`.deb` 安装和正式应用点击矩阵按原计划补齐，不将当前 fixture 证据算成它们通过。
- `fetch-runtime.mjs` 首次下载校验官方 SHA256，缓存命中仅校验 `--version`；后续可增强缓存完整性元数据。这不是当前已观察到的伪造下载，也不单独阻塞技术探针。
- supervisor 是临时 mock 探针：服务发现／附着、完整异常退出与强制结束语义、来源 IPC 校验、客户端 deadline、启动并发和重开窗口仍按 G1 计划实施。现有正常 E2E 成功不作为这些产品场景已经通过的证据。
- 本轮没有扩大 G0 为完整五页面、真实 ZCode 主会话接入或全平台安装要求；这些继续留在既定 G1–G7 阶段。

## 6. 结论与下一步

**G0 REWORK**；已验证的技术选型、固定运行时、IPC／SQLite／MCP 与 dir 打包链可保留。先修 R01–R04 并写返工说明，独立复验契约映射、脱敏反例和状态一致性；若产品实现变化，再运行对应 probe／E2E／打包回归。未通过前不进入 G1，不自动提交、合并或发布。
