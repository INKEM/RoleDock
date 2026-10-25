# P5-R 运行证据

日期：2026-10-13。环境 Node 22.23.2／npm 10.9.8。本目录保留返工前反例与迭代失败；不能把脚本退出0、构建成功或中途专项通过等同最终门禁通过。

- before-*.log：返工前复验反例；执行完毕代表复现成功。
- typecheck-*.log、targeted-*.log、rework-first.log、regression-second.log、core-third.log：开发迭代，含已修正失败和沙箱子进程异常。
- check-final.log：第一轮完整门禁321通过／4失败，退出1；相关遗漏已修正。
- process-recovery*.log：真实退出测试的开发迭代，最初测试 fixture／断言错误已修正，不作 PASS 证据。
- check-final-second.log：28 文件，331通过／1失败，484.24秒，退出1；期间新增独立审查防护补丁，不能作冻结基线通过证据。
- check-final-third.log：28文件、332测试通过、0跳过，492.23秒，退出0；随后实际复现并修正 cancel 抛错跳过回收，进入最后一轮。
- check-final-fourth.log：333／334通过，521.76秒，退出1；锁夹具的未引用数据库被GC释放锁，强制GC对照与修正后回归见 lock-gc-proof.log／lock-gc-regression.log。三个 rd-*.mjs 保存实际诊断脚本（将 holder 两文件置于 /tmp 后运行 proof）。产品64文件基线不变，测试清单重算。
- check-final-fifth.log：最终冻结源码完整门禁，typecheck/build 完成，28文件、334测试通过、0跳过，217.16秒。跨夜恢复时原工具会话失效，未取回退出码；不补写退出码，日志保留全部步骤及通过结尾。
- implementation-final.sha256／worktree-status.txt：最终107份实现及测试文件、实际未提交工作区；清单 SHA256 为 ababb56ab36733b7723d06460974f44c171f8cad899c3d63a34268e9faee71ba。2026-10-14 恢复后再次逐文件核验成功，见 implementation-final-check.log。

独立证据见相邻 `2026-10-13-p5-r-independent/`，结论见 P5-R-review.md。G01 真实 Harness 无证据，保持 BLOCKED；本轮无真实模型或凭据调用。
