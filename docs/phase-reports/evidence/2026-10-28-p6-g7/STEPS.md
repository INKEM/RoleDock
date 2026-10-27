# P6-G7 真机验证 STEPS(汇总:G4/G5/G6 遗留 + G7 安装与矩阵)

前置:安装产物已构建(`packages/desktop/dist-app-shell/roledock-desktop-0.1.0-alpha.0-amd64.deb`,pack-deb-result.json 含布局断言)。截图/日志不得包含凭据。

## A. 安装与启动(GUI-01/GUI-14)

1. 在无本仓库的干净 Linux 环境(或容器)`apt install ./roledock-desktop-*.deb`;应用列表出现 RoleDock;点击启动真窗口;**不得**需要 npm/nvm/终端。截图 `gui-01-install-first-launch.png`。
2. 打开一个 mock 工作空间 → 截 `gui-02-packaged-workspace.png`。
3. 升级路径:以更高版本重装(迁移检查在打开时触发)→ 打开既有工作空间确认数据完好。截图 `gui-03-upgrade-migration.png`。
4. 移除:`apt remove roledock-desktop` → 用户工作空间目录应保留。记录目录列表 `gui-04-keep-workspace.txt`。

## B. 真实 ZCode 桌面会话全链(GUI-04/GUI-05,补 G4 gui-03…07)

5. 沿用 `evidence/2026-10-27-p6-g4/STEPS.md` 步骤 2–4(登记→确认→锚定→观察块),打包产物复演;补拍 gui-03(成功链)gui-04(观察块)。
6. takeover:第二会话确认 takeover → 锚定 → 观察块显示 superseded + 前任 + 代次 +1;截图 gui-08-takeover.png。
7. 真实发布:原会话 `documents.publish` → 知识页出现确切新修订;截图 gui-09-publish.png(GUI-06)。

## C. 知识与请求(GUI-07/GUI-08/GUI-10)

8. 知识页(G5 STEPS):历史比较、候选、导出导入;截图 gui-10。
9. 发起 ≥10 个重叠受管请求(可经原会话 MCP 连发),GUI 收件箱与后端 `requests.listInbox` 逐项对应;截图 gui-11 + `collect-state` 导出。
10. 真实结果采纳:目标角色原会话对已完成请求 `documents.publish(adopt_artifact_id=…)` → 知识页显示确切新修订;截图 gui-12(GUI-10)。

## D. 撤销/取消与恢复(GUI-09/GUI-11/GUI-13)

11. G4 STEPS 步骤 6(撤销面)复演;截图 gui-13。
12. 分别中止:UI 关闭(服务存活)、service SIGKILL(重启恢复 workspace_id/代次不变)、connector 中止(该请求执行不确定→对账);记录各步输出 gui-14-recovery.md。
13. 人工检查:键盘 Tab 焦点、错误/空状态、目标分辨率(1280×800)下五页面渲染、长列表/长正文滚动无冻结;记录 gui-15-ux-notes.md。

## 记录

- 每步记时间点与公开标识(host_session_id/authorization_id/artifact_id 可全文)。
- 完成后补 `FINDINGS.md`:与自动化证据对照,任何不一致按缺陷登记,不掩饰。
- 采集脚本:`collect-state.mjs`(G4 目录)对四视图通用;G6 请求视图可仿其增加 requests.listInbox。
