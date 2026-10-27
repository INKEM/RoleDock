# P6-G7 返工记录(R1)

日期:2026-10-28。对应验收:`P6-G7-review.md`(结论 REWORK,唯一返工项 R1,高优先级;R2 低)。返工基线:HEAD `323506d` 起。

## R1:.deb 启动器符号链接目标是构建机绝对路径

- **验收指认**:`/usr/bin/roledock-desktop` 链接目标为 `/home/inkem/.../debroot/opt/RoleDock/roledock-desktop`——安装后悬空,且把个人源码路径打进发布产物;12 项断言存在盲区。
- **修复**:`pack-deb.mjs` 符号链接目标改为安装后绝对路径 `/opt/RoleDock/roledock-desktop`;新增 3 项断言(链接目标逐字节 == /opt 绝对路径、deb 清单无 `/home/` 与 staging 路径、asar 清单精确无构建机路径),断言总数 12→15。
- **复验运行**(全部退出码 0):`desktop:pack:deb` 15/15 断言 PASS;`packaged-g7-evidence.mjs` 冒烟在新载荷上 6/6 PASS(active generation 1);证据 JSON/PNG 已更新至 `evidence/2026-10-28-p6-g7/`。

## R2:报告与提交不一致(deb yml)

- **验收指认**:报告称 `electron-builder.deb.yml` "删除",实际该文件在 G7 提交中新增且无引用。
- **修复**:文件已删除(其 deb 目标依赖本环境不可用的 app-builder 下载服务,无引用价值);报告表述与提交现状一致。

## 观察项(不阻塞,记录跟进)

- O1:asar 混入 G0 探针死载荷约 1.4MB——后续可在打包清单中剔除;O2:SIGKILL "代次不变"由 g4 restart 变体承载(措辞已在矩阵中对齐);O3:perf 为进程内口径,已在矩阵标注;O4–O6 同验收报告。
- 真机材料(A–D)按 `evidence/2026-10-28-p6-g7/STEPS.md` 待采——**P6-G 总体验收完整 PASS 的前置;未采齐不转 P6-R、不远程发布**(验收 §6 裁定)。

## 结论

R1/R2 已修复并按验收复验方法(重跑打包+冒烟,无需重验门禁/E2E/性能)通过。G7 自动化范围成立;P6-G 子阶段链(G4 PASS→G5 R1 修复→G6 R1 修复→G7 R1 修复)开发+自动化收口完毕,剩余闭环材料为真机 STEPS A–D。
