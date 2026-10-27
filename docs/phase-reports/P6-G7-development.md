# P6-G7 开发报告:桌面全链、可靠性与安装包

日期:2026-10-28。状态:**待独立验收**(真机材料按"待采"如实标注,见 §8)。

基线:HEAD `a17de6c`(G0–G6 与两轮返工修复已提交)上叠加本阶段变更。实施计划留档:`P6-G7-plan.md`(预授权免审批,含无人值守边界裁定)。

## 1. 交付范围(对照 06G7 五项工作)

| 工作项 | 交付 |
| --- | --- |
| 1. 首发安装格式与运行时资源布局 | `.deb` 构建与布局断言:`desktop:pack:deb` 脚本——以 electron 缓存 dist(SHA 定位)+ esbuild 产物 + `@electron/asar` 确定性组装载荷,`dpkg-deb` 组包(FHS:/opt/RoleDock 载荷 + /usr/bin 符号链接 + desktop 入口 + control 元数据);12 项布局断言全过(无 node_modules/源码路径、runtime/vendor 三 bundle 齐全、control 元数据正确);产物 124 MiB |
| 2. GUI-01–14 逐条执行 | 自动化可达部分全部有证据;总体对照矩阵 `P6-G-total-matrix.md` 逐项映射自动化证据与待真机材料;**打包产物全链冒烟**从载荷二进制+打包 MCP bundle 完成锚定全链(active generation 1) |
| 3. G-min 遗留真实点击证据与恢复矩阵 | 真实点击证据属真机材料(汇总 STEPS);恢复矩阵自动化部分:shell E2E 已覆盖 owned crash 恢复/外部服务绝不停止,crash 用例即 SIGKILL 语义;g4 覆盖重启+重登记代次不变 |
| 4. 性能实测 | `desktop:perf` 基线脚本:全量造数集(50 角色/200 会话/1000 请求/1000 修订)实测,数字如实记录(见 §4),不宣称达标 |
| 5. 门禁与总体对照 | 原门禁 553/553 + shell E2E 15/15 + 打包/冒烟/性能新增检查;P6-G 总体对照形成 |

## 2. 源码变化

- `packages/desktop/scripts/pack-deb.mjs`(新):确定性 .deb 组装+12 项断言。**electron-builder 26 的下载代理(127.0.0.1 本地服务)在本环境无法运行(dir/deb 目标均 ECONNREFUSED),故载荷组装绕开它**——electron dist 来自本地缓存(fetch-runtime 固定版本),app.asar 用 @electron/asar 打包(等价于 shell 配置的 files+extraMetadata.main),dpkg-deb 组包零网络。`electron-builder.deb.yml` 删除(其 deb 目标依赖不可用的下载服务;配置本身曾二分定位出 `deb.priority` 非法)。
- `packages/desktop/scripts/packaged-g7-evidence.mjs`(新):打包产物冒烟(真窗口+打开工作空间+装包授权+登记确认+桥推进+**打包 MCP bundle 锚定**+GUI active 显示+截图)。
- `packages/desktop/scripts/perf-baseline.mjs`(新)+ `desktop:perf`:造数集+读视图采样(p50/p95)+启动时间/内存。
- `packages/core/src/testing.ts`:导出 `coordinatorStore`(脚本/夹具用;testing 入口本就是仅测试夹具)。
- `package.json`:`desktop:pack:deb`、`desktop:perf` 脚本。
- 无产品 src 变化、无契约变化(§8 .deb 定档不变——构建工具差异记录于 toolchain 语义,见 §3)、无依赖变动。

## 3. 文档

- `P6-G-total-matrix.md`:GUI-01–14 逐项对照(自动化证据列 + 待真机列,fixture/真实宿主分列)。
- toolchain:无需新依赖;打包工具差异(electron-builder 下载代理不可用→dpkg-deb 确定性组包)记录于本报告 §2 与脚本注释,不改变"deb 唯一首发格式"定档。

## 4. 验证(真实运行,全部退出码 0)

| 检查 | 结果 |
| --- | --- |
| `npm run check` | **553/553 PASS(59 文件)** |
| shell E2E | **15/15 PASS** |
| `desktop:pack:deb` | .deb 124 MiB,**12/12 布局断言 PASS**(无 node_modules/源码路径;runtime/vendor 齐全;control/入口正确) |
| `packaged-g7-evidence.mjs` | 打包冒烟 **6/6 PASS**:载荷窗口→工作空间→装包授权→登记(0600 凭据)→确认→桥推进→打包 MCP 锚定→**active generation 1**→GUI 显示+截图 |
| `desktop:perf` | 造数集(50/200/1000/1000)实测:documents.list p95 **7.32ms**、requests.listInbox **5.67ms**、sessions.listBindings **0.11ms**、authorizations.confirmations **1.64ms**、checkpoints.list **0.04ms**、requests.get **4.72ms**;service 启动 264ms;RSS 150MB(进程级,非整机)。参考目标 p95≤500ms——**实测远低于参考值,但仅代表本机与该数据集,不宣称容量达标** |

失败/返工记录(均修复复跑):① electron-builder dir/deb 目标在本环境因下载代理不可用失败(二分定位 `deb.priority` 亦非法)→改为确定性自组装;② 打包冒烟脚本三处 .mjs 语法(TS 标注残留)、discover 行选择(fixture subject 不匹配→按行选择)、桥推进谓词(授权生成后阶段文案本含"等待 Agent")——均以失败诊断输出定位修复。

## 5. 退出条件对照(06G7)

- GUI 全矩阵:14 项全部有自动化证据或明确待真机标注(总体矩阵);无 fixture 冒充真实宿主。
- 安装无需开发仓库/终端:载荷断言 + 打包冒烟(从产物目录启动,无 node_modules)——完整"干净系统安装"留真机。
- 原会话与受管请求真实跑通:原会话链为 mock 自动化+G3 真机链证据;真实宿主复演与真实采纳留真机 STEPS。

## 6. 证据

`docs/phase-reports/evidence/2026-10-28-p6-g7/`:`pack-deb-result.json`(12 断言)、`packaged-g7-evidence.json/png`(冒烟 6 检查+截图)、`perf-baseline.json`(实测数字)、`STEPS.md`(真机汇总:A 安装/升级/移除、B 原会话链+takeover+发布、C 知识与 10 请求+采纳、D 撤销/恢复/UX)。

## 7. 退出条件自查(06G7)

- GUI 矩阵:自动化列全绿;待真机列有 STEPS 与预期产物名——**不因材料待采而宣称完成**。
- 原门禁+新增检查通过(§4)。
- 未通过不转 P6-R、不远程发布(遵守;真机闭环完成与否由独立验收与用户裁定)。

## 8. 遗留与风险

1. **真机材料待采**(本轮唯一未闭环面):A–D 清单见 STEPS.md;G4 gui-03…07 与 G5/G6 截图合并其中。这是 P6-G 总体验收完整 PASS 的前置材料。
2. electron-builder 的 deb 目标与 app-builder 下载代理在本环境不可用——若未来环境恢复,可切回 electron-builder deb 目标(载荷断言脚本即验收器,两种组装方式可互换)。
3. owner 取消 running 不调 adapter.cancel 协商中断(G6 验收观察项)——建议真机 GUI 复演时确认 zcode 实际停止行为,必要时 G7 复核后补 ADR。
4. 性能数字为本机实测(内存为脚本进程粒度);未做真实多日运行的老化测试。

## 8a. 复审返工 R1/R2(2026-10-28 补记)

首次独立验收结论 REWORK(`P6-G7-review.md`):R1(高)——/usr/bin 符号链接目标为构建机绝对路径;R2(低)——deb yml 报告不一致。修复:链接目标 /opt 绝对路径+新增 3 项清单/链接断言(12→15,含无构建机路径泄漏);deb yml 已删除。复验:`desktop:pack:deb` 15/15 断言、打包冒烟 6/6(新载荷)。详见 `P6-G7-rework.md`。真机材料按验收 §6 裁定:不阻塞代码路径验收,但 P6-G 总体验收完整 PASS 前必须采齐。

## 9. 停止点

本阶段完成即停止:P6-G 子阶段链(G4→G5→G6→G7)开发+自动化收口完毕;不 commit 由流水线批处理执行(不推送)、不进入 P6-R、不远程发布。交独立验收 Agent 按 `prompts/REVIEW.md` 形成 `P6-G7-review.md`。
