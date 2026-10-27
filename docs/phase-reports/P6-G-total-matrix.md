# P6-G 总体验收对照矩阵(G0–G7)

日期:2026-10-28。对应:DESKTOP_GUI_PLAN §15 总体验收矩阵(GUI-01–GUI-14)。本表逐项映射**自动化证据**(真实运行过的测试/脚本)与**待真机材料**(需用户配合的 STEPS)。fixture 证据与真实宿主证据严格分列;自动化证据不冒充真机证据。

自动化门禁基线(2026-10-28,G7 时点):`npm run check` 553/553;shell E2E 15/15;`.deb` 打包 + 布局断言通过;打包产物全链冒烟通过;性能基线已实测(见 evidence/2026-10-28-p6-g7)。

| 编号 | 场景 | 自动化证据(已运行) | 待真机材料(STEPS) |
| --- | --- | --- | --- |
| GUI-01 | 安装后启动与工作空间打开 | `.deb` 构建+布局断言(pack-deb-result.json);**打包产物冒烟**:载荷二进制启动真窗口→打开工作空间→装包/授权→登记/确认→桥推进→打包 MCP 锚定→active generation 1(packaged-g7-evidence.json+截图) | 干净系统 `.deb` 安装(无 node_modules/终端)→首次启动;缺依赖指引画面截图 |
| GUI-02 | 多窗口/重复启动/附着 | shell E2E:两窗口一 writer、关闭窗口服务存活、重复启动单实例聚焦、外部服务附着不抢锁(shell.e2e.spec) | 真机多窗口与附着复核截图 |
| GUI-03 | 角色与策略 | g2 E2E:demo-team 安装、requested vs grants 分列;G7 冒烟含装包授权 | custom-role 包真机安装截图 |
| GUI-04 | 原 ZCode 桌面会话锚定 | mock 全链自动化(G3/G4/G7 冒烟);fixture≠真实宿主,如实分列 | **真机**:原 ZCode 桌面会话发现→登记→确认→真 MCP 锚定→active(2026-10-27-p6-g3 已有真机链证据;G7 需在打包产物上复演) |
| GUI-05 | 状态与生命周期 | g4 E2E:连接/有效性分列、superseded/revoked/expired 显示、时间线 | 真机截图(含 G4 gui-03…07 补拍) |
| GUI-06 | 继承与发布 | core:g4-observability takeover 时间线+前任;anchor.test 恢复不加代次;旧主拒绝发布(既有) | 真机:真实发布后新修订显示 |
| GUI-07 | 角色知识 | g5 E2E+core/service 单测:历史/来源/可见性、候选/草稿不假报发布、冲突保留 | 真机知识页截图 |
| GUI-08 | 受管请求 | g6 E2E:真实请求执行→GUI 一一对应→产物;service 测试含 10 请求重叠对应复核路径(验收方 52 项探针含 overlap 10 项) | 真机受管请求轮次截图 |
| GUI-09 | 撤销、取消与迟到 | g4 E2E 撤销面;core g6 cancelByOwner §6 矩阵逐格;迟到拒收(既有) | 真机撤销/取消截图 |
| GUI-10 | 结果采纳 | g6 E2E 采纳指引+确切修订;g5 候选/采纳分列 | **真机**:主角色 `documents.publish(adopt_artifact_id)` 全程 |
| GUI-11 | 异常退出与恢复 | shell E2E:owned crash recovers、外部服务绝不停止;g4 E2E:重启+重登记代次不变;SIGKILL 变体由 crash 用例覆盖(kill -9 语义) | 真机三进程分别中止复演记录 |
| GUI-12 | 渲染与身份边界 | 词汇表/红action/发送方校验测试(全阶段);CSP;E2E 无 token 断言;G5-R1 body 逐字节保真回归 | —(以测试为准) |
| GUI-13 | 可用性与性能 | 性能基线实测:全量造数集(50 角色/200 会话/1000 请求/1000 修订)下 owner 读视图 p95 ≤ 7.32ms(参考目标 500ms);轮询 2s 有界 | **真机**:键盘/焦点/分辨率人工检查;大正文渲染目测 |
| GUI-14 | 安装/升级/移除 | .deb 布局断言:无 node_modules/源码路径;control 元数据;desktop 入口 | **真机**:安装→升级(迁移检查)→移除保留工作空间 |

真机 STEPS 汇总:`docs/phase-reports/evidence/2026-10-28-p6-g7/STEPS.md`(合并 G4 gui-03…07、G5 知识页、G6 收件箱与上表待采项)。

结论口径:自动化证据覆盖全部 14 项的代码路径;GUI-01/04/06/10/13/14 的**真实环境/真实宿主**材料待用户配合采集;未采集完成前,P6-G 总体验收按流程由独立验收 Agent 裁定(材料待采不阻塞代码路径验收,但完整退出条件需真机闭环)。
