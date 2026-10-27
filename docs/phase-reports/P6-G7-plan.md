# P6-G7 实施计划:桌面全链、可靠性与安装包(留档)

日期:2026-10-28。状态:**计划定稿,按用户预授权实施;真机项按"材料待采"如实标注,不伪装**。
前置:P6-G6 已收口(验收 REWORK→R1 实现修复复验,`P6-G6-rework.md`)。
依据:`prompts/06G7-release-validation.md`、计划 §15(总体矩阵 GUI-01–14)、§16、§17、契约 §8(deb 为唯一首发格式候选)、G0 定档与 `scripts/packaged-*-evidence.mjs` 先例。

## 0. 范围裁定(无人值守边界,如实分层)

- **本轮可自动化交付**:
  1. `.deb` 打包定档落地:electron-builder deb 配置(应用本体+打包 Node 运行时+连接器 bundle;不含 node_modules、ZCode 账户、个人 helper、测试目录),`npm run desktop:pack:deb` 产出产物;校验布局(解包检查:无源码路径、runtime 在 resources、desktop 入口文件)与安装体积/文件数实测。
  2. **打包产物运行冒烟**(GUI-01 的自动化部分):从打包产物启动真实 Electron 窗口(不依赖仓库 node_modules——在打包目录直接执行),打开 mock 工作空间跑一条完整 mock 链(打开→安装→确认→锚定);沿用 `packaged-*-evidence` 先例脚本化。
  3. **性能基线**(计划 §15 造数集):脚本向工作空间注入 50 角色/200 外部会话/1000 请求/1000 文档修订,对 owner 读视图(目录/请求列表/绑定列表)与登录页轮询各采样 N 次,记录 p95;连同 CPU/内存/安装体积/启动时间实测写入基线文档。**不宣称已达目标,只记录实测**。
  4. **恢复矩阵自动化部分**(GUI-11):UI 关闭服务存活(已有 E2E)、service 崩溃恢复(已有)、补充:service 被杀 → UI 显示 disconnected → 重启恢复 workspace_id/代次不变(g4 已有 restart;补 SIGKILL 变体);connector 为逐请求进程,中止即该请求执行不确定 → 对账路径(引用既有语义,不新增)。
  5. **P6-G 总体对照文档**:GUI-01–14 逐项映射"自动化证据(测试/脚本/日志)"与"待真机材料(STEPS)",区分 fixture 与真实宿主证据。
- **待真机补采(材料待采,不伪装)**:GUI-01 完整安装环境(无 node_modules 的干净系统 .deb 安装)、GUI-04 真实 ZCode 桌面会话锚定、GUI-06/10 的真实发布/采纳、GUI-13 人工键盘/焦点/分辨率检查、GUI-14 安装/升级/移除全流程。真机 STEPS 汇总一份(G4/G5/G6 遗留 + 本阶段)。
- **不做**:不打包账户/helper/测试目录;不加 `--no-sandbox`;不把非受管路径标 full;不宣称容量/性能达标;未通过不转 P6-R、不远程发布。

## 1. 实施分层

1. **打包**:`packages/desktop/electron-builder.yml` 增 deb 目标(maintainer/category/图标;extraResources: dist-desktop 服务 bundle、connector bundle、runtime node);`scripts/pack-deb.mjs`(build→产物路径输出→布局断言);npm script `desktop:pack:deb`。
2. **打包冒烟 E2E** `g7-packaged.e2e.spec.ts`:定位 deb 解包目录或 dir 产物可执行,launch 真窗口,无仓库依赖断言(cwd 指向产物目录;进程 env 清理 PATH 中的仓库 node_modules 不可行——以"产物内文件齐全+从产物目录启动"为自动化等价),完整 mock 链一条。
3. **性能脚本** `scripts/perf-baseline.mjs`:造数 + ServiceClient 计时 + JSON 结果落盘;`npm run desktop:perf`。
4. **恢复矩阵** `g7-recovery.e2e.spec.ts` 或并入既有 spec:SIGKILL service → disconnected → restart → workspace_id/generation 不变。
5. **文档**:`docs/phase-reports/P6-G-total-matrix.md`(GUI-01–14 对照)、性能基线 JSON+MD、真机 STEPS 汇总、契约(如 deb 配置有契约级变化则 v10,否则不动)、toolchain(若打包引入新依赖)。
6. `P6-G7-development.md`(待独立验收,如实标注待真机项)+ 证据目录 + 分批提交(不推送)。

## 2. 退出条件对照(06G7)

- 自动化可达部分全绿;GUI 矩阵逐项有证据或明确的"待真机"标注与 STEPS;原门禁 + 新增打包/冒烟/性能检查通过;fixture 与真实宿主证据分开报告。
- 真机项未完成即如实标注"材料待采",不通过不转 P6-R(由验收与用户裁定)。
