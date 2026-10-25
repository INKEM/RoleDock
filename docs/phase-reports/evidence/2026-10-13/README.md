# 2026-10-13 本地验收证据

本目录对应 HEAD `a083874` + 原 P5 工作区。源码基线见 `baseline.txt` 和 `implementation-baseline.sha256`。日志包含临时角色、会话 ID 与测试目录，均为模拟数据；没有真实账户凭据或私人会话材料。

## 门禁证据

- `npm-ci.log`：精确安装成功。
- `check-sandboxed.log`：类型／构建成功，子进程环境限制导致 24 失败、255 成功；不能记全通过。
- `check-unsandboxed-timeout.log`：沙箱外类型／构建成功，180 秒测试预算用尽；不能记全通过。
- `vitest-unsandboxed.log`：沙箱外完整 26 文件、279 项测试通过，0 跳过，192.76 秒。

## 专项复现

脚本只使用本仓库当前构建产物、Mock 及 `/tmp` 模拟工作空间。脚本退出 0 表示缺陷出现并完成记录，不是验收 PASS；输出对象和数据库状态是判断依据。复验修复后应把这些行为转成有实际断言的回归测试，而不能维持以缺陷为成功条件的脚本。

从仓库根目录执行（先 `nvm use` 与 `npm run build`）：

```bash
mkdir -p /tmp/roledock-audit-p0-p2
node docs/phase-reports/evidence/2026-10-13/repro-p0-p2.mjs > /tmp/roledock-audit-p0-p2/results.txt
node docs/phase-reports/evidence/2026-10-13/repro-loader.mjs
node docs/phase-reports/evidence/2026-10-13/repro-knowledge-receipts.mjs
node docs/phase-reports/evidence/2026-10-13/repro-p3-p5.mjs
node docs/phase-reports/evidence/2026-10-13/repro-lookup-this.mjs
```

`repro-knowledge-receipts.mjs` 读取首个脚本记录的临时工作空间，因此需按顺序执行。脚本相对定位仓库，可移动检出路径；固定 `/tmp/roledock-audit-p0-p2/results.txt` 为脚本间证据文件，重复运行首个脚本会生成新的临时工作空间。

| 日志 | 记录内容 |
| --- | --- |
| p0-p2.log | 无 grants／撤权发布、过期提案基线、知识导入目录边界、公开任职捷径 |
| loader.log | 非允许 Schema 引用、嵌套引用及目录模板被接受 |
| knowledge-receipts.log | 摘要不增知识修订、公开伪回执及请求前置 |
| p3-p5.log | 受限适配器仍执行、幂等返回代次、空知识载入、预算、终态、实际到期、断线恢复、重叠创建、摘要保留、恢复 payload |
| lookup-this.log | 不确定创建对账丢失方法 this |
| bridge-cancel.log | 取消标记后 fixture-host 仍接受轮次 |

P3–P5 脚本对故障路径进行可控插桩：Mock 返回期间取消、延迟返回直至真实期限经过、故障抛出、重叠创建屏障；不修改产品实现。重启反例用内部存储构造“provisioning 意图已经提交、宿主尚未创建”的确切退出点。结果不计为真实 Harness 证据。

`bridge-cancel.log` 来自直接运行 fixture-host 的专项观察。可用适配器创建会话后执行 cancel，再 runTurn，并检查轮次计数；当前 cancel 只写标记，宿主 turn 不读取标记。固定回答夹具不是模型或已接入真实宿主。
