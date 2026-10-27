# P6-G2 返工最终独立复验

日期：2026-10-26。结论：**PASS**。本轮关闭 **G2-R01、R02、R06**，R03/R04/R05 回归通过、维持关闭。G2 的工作空间、接入预检、角色与策略管理达到本子阶段退出条件，可作为 G3 输入。本轮止于验收，没有开展 G3。

## 1. 范围与基线

按用户“验收返工成果”，复验 [P6-G2-development.md §10](P6-G2-development.md)，前序裁定为 [G2 返工 REWORK](P6-G2-rework-review.md)。依据 AGENTS、开发蓝图、toolchain、桌面 GUI 计划、ADR-0013、GUI 契约 v6、COMMON、REVIEW 与 `06G2-workspaces-and-roles.md`。[G0 PASS](P6-G0-final-review.md)、[G1 PASS](P6-G1-final-review.md) 前置成立。

实际基线：HEAD `d9743365256459a773a5319791cf3b7bb2e5fbe7` 加当前未提交工作区。相对上轮冻结清单，变化为 core/admin、desktop/supervisor、service/bin、两份相关测试、GUI 契约和 G2 开发报告，共七文件。源码、Schema、测试、构建脚本、锁文件、契约与开发报告共 **129 文件**，验收前后哈希一致，见 [基线核对](evidence/2026-10-26-p6-g2-final-independent/baseline-verification.json)。

验收未修改产品、契约、开发报告或依赖；仅新增独立证据、本报告与历史报告的最新裁定指针。没有提交、合并或发布。

## 2. 返工关闭矩阵

| 原编号 | 当前实现与独立实证 | 裁定 |
| --- | --- | --- |
| R01 目录身份与误连 | bin 正常停机保留 workspace-id；活端点附着对身份分 absent/present/corrupt，缺失、损坏、链接或不匹配均 conflict。原“停止 A 后植入 B 连接”的反例已拒绝，owner 安装失败，B 无变化；正确恢复和 A/B 切换通过 | **关闭** |
| R02 launcher 恢复与异常配置 | persistedLauncher 区分 absent/present/error。新打包版配置链接、目录、损坏 JSON、未知 kind、不可读文件均明确 error；未启动 mock。正常 restart、停止重开、应用重开、SIGKILL 重开保持 zcode，修复配置后恢复原 workspace_id | **关闭** |
| R03 打包连接器路径 | 从当前源码重新打包，在仓库外的临时 cwd 启动；随包 Node 加载包外 runtime/vendor 连接器，预检、握手、zcode 服务启动及 mock 对照通过 | **维持关闭** |
| R04 最近记录持久化 | 真实窗口 E2E 的移除及页面重入通过；打包版设置回读、磁盘 JSON、应用重启回读均不含已移除项，工作空间目录保持存在 | **维持关闭** |
| R05 launcher 配置保护 | 独立重跑首次写入／更新 0600；配置文件链接、状态目录链接拒绝，目标内容、权限、inode、链接及空目录状态保持 | **维持关闭** |
| R06 角色材料正文 | 按包相对文件路径读取安装快照，不再判断扩展名。无扩展名包职责／模板／Schema 三项精确正文对照通过；修改源目录不改变安装视图；安装材料缺失／变成目录明确 INTERNAL，恢复后可读 | **关闭** |

### R01 关键反例与恢复

证据：[05-identity.json](evidence/2026-10-26-p6-g2-final-independent/05-identity.json)。本轮 A=`ws-b3f9b0f9`、B=`ws-348c5c9a`，均为验收自建临时工作空间。停止 A 后身份文件仍存在；将 B 的有效连接放入 A 后，经桌面使用的 WorkspaceController 打开 A 得到 conflict，安装被拒，B 的角色列表为空。

进一步移除身份、写入无效内容、将身份改成链接，三种情况均 conflict、拒绝 owner 写入、B 保持为空。恢复 A 的原身份与陈旧端点后可正常启动 A；随后在 A 安装 custom-role、在 B 安装 demo-team，再切回 A，两个角色列表与各自工作空间对应。该检查实际验证数据分离，未仅以 ID 未变替代“未污染”。八项独立断言全部 true。

### R02 关键反例与生命周期

证据：[09-packaged.json](evidence/2026-10-26-p6-g2-final-independent/09-packaged.json)。同一个新打包应用建立 ZCode 工作空间后，restart、停止重开、应用退出重开、对其自有服务执行 SIGKILL 后重开均保持 adapter=zcode。CLI 路径失效时 disconnected，mode 仍为 zcode，没有改用 mock。

原配置链接反例现在得到 error，链接与合成目标原样。目录、损坏 JSON、未知 kind、不可读配置四种扩展边界均 error、pid=null、无 service.sock；恢复常规配置后同一 `ws-ca0a0487` 再次 running，诊断 adapter=zcode。全新无配置目录仍可通过 mock 诊断启动。十四项打包检查全部 true。

### R06 关键反例与快照

证据：[06-materials.json](evidence/2026-10-26-p6-g2-final-independent/06-materials.json)。自建合法角色包的三份材料分别为 `materials/guide`、`materials/layout`、`materials/record`，manifest 校验及安装成功。经真实本地服务 owner RPC 返回的职责、模板、Schema 均与原文精确一致；修改源 guide 后，查询仍返回安装快照正文。

删除安装副本的 guide、将其替换为目录，roles.get 均返回明确 INTERNAL；恢复原文后重新可读。六项独立断言全部 true。标准 demo-team 的 .md/.json 三项正文精确对照在新打包窗口中也通过。角色包及文件均为临时验收数据，没有更改仓库示例。

## 3. G2 条件对照

| 提示词条件 | 当前文件／验证路径 | 结果 |
| --- | --- | --- |
| 创建／打开／最近记录、身份校验、错误恢复，不删除项目 | supervisor、workspace-controller、IPC 与 workspace 页面；11 场景 E2E、身份扩展检查、打包记录持久化 | **PASS** |
| ZCode launcher、CLI／connector／helper 引用／模型／出口配置 | service bin 的 workspace-config；launcher 配置模块与设置／预检；新打包产物实际零模型启动与恢复 | **PASS（G2 配置与服务底座范围）** |
| 默认只读预检、独立连接测试 | Node／CLI／connector/bwrap/userns/目录专项；随包 Node 的 connector --check；握手与 tools/list 为独立调用，无模型轮 | **PASS** |
| 任意合法角色包、职责／模板／Schema、哈希／主指针／需求与策略 | roles.get／policy.list Schema、service 边界、core 只读投影及 roles 页面；custom-role、无扩展名新包及标准包对照 | **PASS** |
| 安装不 grant，initialized 不等于可服务，选择角色不打开会话 | G2 E2E 与 service 专项，角色详情 grants 为空及无会话入口断言；无业务角色 conformance | **PASS** |
| 策略 grant/revoke 回读，撤销后下一次动作拒绝 | 窗口 E2E 回读；另经 Mock 绑定与实际 service 的下一次 documents.list 返回 PERMISSION_DENIED | **PASS（本地 Mock 权限边界）** |
| 失败／缺依赖／冲突如实呈现 | 预检单测、owner/session 权限、身份与配置错误矩阵；本机 E2E 实际走 CLI 存在分支 | **PASS（已测分支）** |

本轮没有新增 owner 权限、角色授权或会话工具，不修改核心身份／代次／正式发布守卫。来源与权限边界分别验证，不把能连接 ZCode 等同于角色已锚定。

## 4. 独立执行与证据

统一目录：[2026-10-26-p6-g2-final-independent](evidence/2026-10-26-p6-g2-final-independent/)。执行命令见 [RUNS.md](evidence/2026-10-26-p6-g2-final-independent/RUNS.md)。环境：Node 22.23.2；随包服务诊断 runtime=v22.23.2；本机预检 CLI=**0.17.0**、bubblewrap=0.6.1，namespace 干跑通过。没有将 toolchain 的早期 CLI 版本当成本轮实际结果。

| 命令／检查 | 独立结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | `01-typecheck.log` |
| `npm run desktop:build:shell` | exit 0 | `02-build-shell.log` |
| vitest：desktop/protocol/service/MCP/服务重启/核心策略/无业务角色十四文件 | **123/123 PASS**，exit 0，103.39s | `03-focused.log` |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts` | **11/11 PASS**，exit 0，约 1.5 分钟；无跳过，本机实际走 ZCode 分支 | `04-shell-e2e.log` |
| 原身份反例及缺失／损坏／链接／恢复／切换扩展 | exit 0，八项断言全 true | `05-identity.json/.stderr`、`check-identity.mjs` |
| 无扩展名正文、源目录变更、安装材料缺失／非常规文件与恢复 | exit 0，六项断言全 true | `06-materials.json/.stderr`、`check-materials.mjs` |
| 配置写入与链接目标保护 | exit 0，全部断言 true | `07-config-safety.json/.stderr`、`check-config-safety.mjs` |
| `npm run desktop:package:shell` | exit 0，当前源码重新生成 Linux dir 产物 | `08-package-shell.log` |
| 新打包产物 mock／zcode、连接测试、生命周期、异常配置拒绝与恢复、最近记录 | exit 0，十四项检查与三项标准正文对照全 true | `09-packaged.json/.stderr/.png`、`check-packaged.mjs` |
| Mock 绑定撤权后下一角色动作 | exit 0；撤前读取成功，撤后同一绑定读取 PERMISSION_DENIED | `10-policy-action.json/.stderr`、`check-policy-action.mjs` |

本轮产品验证没有失败或跳过项。基线采集辅助脚本最初使用 Node execFileSync(git) 遇到沙箱 EPERM；已改用直接 shell git 成功采集，保留 [辅助说明](evidence/2026-10-26-p6-g2-final-independent/00-harness-notes.txt)，该情况不算产品测试失败或通过。没有修改实现以满足验收脚本。

开发方 `17-check-r2.log` 的 **50 文件／511 测试 PASS** 是开发证据；本轮未独立重跑全量 `npm run check` 或 `npm ci`，不将 511 计入独立通过数。

## 5. 范围限制与下一步

- G0 探针未在本轮单独重跑；G1 shell 生命周期、单 writer、附着、窗口恢复和 IPC 边界随 11 场景回归。原生目录自动化继续使用文档化 fixture，没有新增人工目录点选证据。
- 新打包扩展检查通过实际 Electron 窗口的有限 preload IPC 驱动；按钮／页面行为另由 E2E 覆盖，不把全部 IPC 步骤写成人工点击。
- 真实 ZCode 验证仅 CLI 版本、连接器握手、服务底座和配置生命周期，**零真实会话、零模型轮**。本次没有验证带真实 helper 的模型可用性、受管请求执行或原桌面会话角色锚定；这些继续按 G3/G7 要求补证，不能把本轮 PASS 外推为完整桌面产品已完成。
- R05 回归涵盖已发现的常规文件／链接覆盖边界，不宣称穷尽所有并发文件系统场景。

**G2 PASS**。下一子阶段为 `prompts/06G3-session-authorization.md`；本轮不自动开始开发、提交或发布。
