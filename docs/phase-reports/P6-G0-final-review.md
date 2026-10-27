# P6-G0 返工最终独立复验

后续阶段状态更新：G1 已在 [P6-G1-final-review.md](P6-G1-final-review.md) 独立复验 **PASS**；本文对 G1 REWORK 的记载保留为当时历史状态，G0 PASS 不变。

日期：2026-10-26。结论：**PASS**。G0 的 R01–R04 均已关闭；本结论仅覆盖技术探针和操作契约。G1 独立返工复验仍为 REWORK，不能据此进入 G2。

## 1. 范围与基线

按 `prompts/REVIEW.md`、`06G0-contract-and-spike.md`、开发蓝图、toolchain、桌面计划、ADR-0013，复验 [开发报告 §10](P6-G0-development.md) 与 GUI 契约 v3。保留 [首轮验收](P6-G0-review.md) 和 [上轮返工复验](P6-G0-rework-review.md) 的历史 REWORK，本报告为 G0 最新裁定。

基线为 HEAD `d9743365256459a773a5319791cf3b7bb2e5fbe7` + 当前 G0/G1 未提交工作区。验收前后源码／Schema／测试／配置／被审查材料共 76 文件哈希一致，见 [基线核对](evidence/2026-10-26-p6-g01-rework-independent/baseline-verification.json)。没有修改产品、被审查契约、ADR 或开发报告；本轮写入验收报告、历史报告指针和独立证据。

## 2. 返工关闭矩阵

| 原项 | 实际复验 | 判定 |
| --- | --- | --- |
| R01 脱敏误改业务字段 | 两桥接仅对具名自由文本执行标注型秘密掩盖，公开 SHA256、32 hex 宿主标识、长事件引用、嵌套数组哈希全部精确相等；秘密字段仍移除，Bearer 文本仍掩盖 | **关闭** |
| R02 管理取消状态／回收语义 | 维持上轮关闭结果；契约仍覆盖八态、幂等键、cancel 能力、迟到拒收、execution_uncertain、cleanup_pending、owner 审计，通知不产生答案／发布权 | **关闭** |
| R03 页面读模型映射 | `checkpoints.list` 明确摘要元数据、待办计数及未完成描述；`checkpoints.get` 明确 handoff_summary.body、todos[{description,done}]、sources 与引用。业务待办与绑定状态诊断分开，owner 可见性与被引用私有文档正文隐藏规则明确；其余修订／候选／产物／runtime／cleanup 映射维持 | **关闭** |
| R04 提前宣称验收通过 | ADR 与计划在本次实际复验前保持开发候选／待独立验收，并保留 REWORK 历史；不存在先自行翻为 PASS 的情况 | **关闭** |

R01 复现直接内存转译当前两个桥接源文件，结果见 [06-redaction.json](evidence/2026-10-26-p6-g01-rework-independent/06-redaction.json)；每个公开值精确相等与秘密移除／文本掩盖断言均为 true。此检查没有使用真实凭据。

R03 仅为 G0 契约验收，不表示 G5 查询已实现。G1 对 workspace.info 的实际交付及其缺失的 JSON Schema 由 [G1 返工报告](P6-G1-rework-review.md) 单独裁定，不将后续实现问题混作 G0 契约映射缺失。

## 3. 技术退出条件复核

| 条件 | 当前证据与边界 | 结果 |
| --- | --- | --- |
| 可运行的一套技术路径 | Electron 44.9.3／TS DOM／esbuild；独立固定 Node 22.23.2，不依赖 Electron 内置 Node 执行 SQLite | 满足 |
| 具名 IPC、无 renderer 凭据／通用 RPC | 当前 probe 与 shell 契约专项及实际 Electron E2E 通过；本轮公开值修复未取消秘密字段防护 | 满足当前探针范围 |
| SQLite 单 writer、MCP 子进程、生命周期 | 当前 probe E2E 与打包成功自检确认 SQLITE_BUSY errcode=5、MCP 14 工具及 authorizations.get；正常关窗／退出路径有实测 | 满足 G0 探针范围；G1 产品生命周期另验 |
| 打包能定位固定 runtime 与资源 | 标准 dir 打包 exit 0；两次成功的打包自检均 mode=packaged、runtimeVersion=v22.23.2、四检查全 true | 满足可运行条件；首跑超时完整记录于 §5 |
| 操作映射／可见性／幂等定档 | 契约 v3 补齐本轮剩余映射，owner 读模型不借角色身份，正式发布仍走当前角色会话 | 满足 G0 契约范围 |
| 精确依赖与边界 | 固定版本、锁文件和工具链沿用既有定档；本轮未新增工具链依赖或真实模型任务 | 满足 |

原生目录选择本轮仍使用已声明 fixture；真实点选回传、正式 deb 安装、原 ZCode 桌面会话接入不计为本轮通过，按既定阶段补齐。

## 4. 本轮独立执行

证据目录：[2026-10-26-p6-g01-rework-independent](evidence/2026-10-26-p6-g01-rework-independent/)。Node 22.23.2 / npm 10.9.8；本地 socket／Electron 检查经自动审批使用临时 mock 工作空间与隔离 userData，没有系统安装或远程发布。

| 命令／检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `01-typecheck.log` |
| `npm run desktop:build:shell` | exit 0 | `02-build-shell.log` |
| desktop/probe/shell/service/deadline/mcp/服务重启/无业务角色专项 | **8 文件、96/96 PASS**，exit 0 | `03-focused.log` |
| shell 真实 Electron E2E | **5/5 PASS**，exit 0 | `04-shell-e2e.log` |
| 两个桥接源文件保真与脱敏合成反例复验 | 全部断言通过，exit 0 | `06-redaction.json`、`revalidate-redaction.mjs` |
| `npm run desktop:build` | exit 0 | `07-build-probe.log` |
| probe 真实 Electron E2E | **1/1 PASS**，exit 0 | `08-probe-e2e.log` |
| `npm run desktop:package` | exit 0，重建 Linux dir 产物 | `09-package-probe.log` |
| 新产物 `--selfcheck` 首跑 | **exit 1**，服务 owner 文件就绪等待 20s 超时；不可计为通过 | `10-packaged-probe-selfcheck.log`、`10-packaged-probe-first-state.json` |
| 同产物，全新显式临时目录重跑 | exit 0，固定 runtime／RPC／SQLite／MCP 四项通过，正常停机清理端点 | `11-packaged-probe-retry.log`、`11-packaged-probe-state.json` |
| 同产物，默认临时目录再次运行 | exit 0，四项通过，正常停机清理端点 | `12-packaged-probe-default-retry.log`、`12-packaged-probe-default-state.json` |

未重跑 `npm ci` 或完整 `npm run check`；开发方 45 文件／489 测试全绿属于开发证据，不充作独立重跑。以上 96 项与 6 个 E2E 是本轮实际执行结果；G1 边界反例另见其报告，未计为成功行为。

## 5. 非阻塞观察项 N1：打包首跑启动等待超时

首次启动新打包产物时，service 在 20s 内未生成就绪 owner 文件，探针返回失败；原失败日志及不含凭据的状态均保留。之后未改变产品或产物，显式隔离目录和默认目录各一次均约数秒完成，固定 Node、SQLite、MCP 全部通过，**尚未定位首跑超时原因**，不能断言一定是机器负载，也不能将首次失败改写为通过。

G0 的“技术探针可运行、打包定位资源”已由相同产物的两次成功实测确认，因此该单次未重复的启动等待问题记录为观察项，不新增 G0 必须返工项。后续若重复出现，需采集 service 就绪阶段／进程错误与耗时，定位启动可靠性问题。完整产品的 child 存活、异常恢复与等待结果继续由 G1-R02 约束。

## 6. 结论与阶段门

**G0 PASS，R01–R04 全部关闭。**可以保留已定档技术路线与操作契约。当前只继续 G1 返工；[G1 最新报告](P6-G1-rework-review.md) 为 **REWORK**，仍不能进入 G2。未自动开发后续阶段、提交、合并或发布。
