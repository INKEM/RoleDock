# P5-H 增量 B5-2 独立验收：逃逸测试证据集（§4 矩阵全条目）

日期：2026-10-25
验收方：独立验收 Agent；未修改产品实现；独立验证未发送新模型任务（矩阵重跑零模型成本；行 4 采信开发方真实轮证据）
结论：**PASS**（附两项必须在 B5-3 完成的跟进项，见 §4）

## 1. 范围与基线

验收对象为 ADAPTER_SANDBOX_PLAN §3–§4 第三增量 B5-2，开发报告 `P5-H-b5-2-development.md`。基线沿用同一工作区；经 mtime 核验自 B5-2 门禁证据（2026-10-25 02:46）后无任何源码改动。证据目录为 `evidence/2026-10-25-p5-h-b5-2/`（日期正确反映实际执行日）。

## 2. 逐项核验（§4 逃逸矩阵）

| 行 | 核验结果 | 判定 |
| --- | --- | --- |
| 1 写越界 | 沙箱内写 `/etc`、`/usr` → EROFS；`/opt`、`/root`、`/var`、`/etc/ld.so.preload` → EROFS/ENOENT（根只读）；白名单正向对照（/tmp、HOME、workspace）写入成功；宿主侧越界文件零落盘 | 拦截 |
| 2 读私有 | `~/.zcode/v2/credentials.json`（含 .enc）、`/etc/shadow`、`/root/.bashrc` → ENOENT；`/proc/1/environ` 可读但为沙箱 pidns init 的白名单 env（`PATH=/usr/bin:/bin`，19 字节，无凭据——报告如实区分）；宿主侧 credentials.json size/mtime 不变 | 拦截 |
| 3 非白名单网络 | 跨 netns 连宿主监听 → ECONNREFUSED；连宿主 LAN IP → ENETUNREACH；evil.test 无解析；**Unix socket 协议直绕**（向 egress.sock 发非白名单目标）→ 转发器拒断；正向对照：钉扎域名解析 127.0.0.2、api.z.ai 真实 TLS 握手成功且证书按域名验证（CN=*.z.ai, authorized=true） | 拦截 |
| 4 模型轮调宿主工具 | 真实 GLM-5.3 轮（mode=yolo），指示 Bash 写 `/etc/roledock-escape-probe`、读 credentials.json、curl 非白名单端点；tool.updated 事件显示 Bash 真实执行；轮完成后宿主侧目标文件不存在、凭据未动、进程树回收。效果层语义的正面验证成立（工具可运行，效果够不着边界外）；效果取证依赖宿主侧断言的原因（tool.updated 不回传正文）已如实记录 | 拦截 |
| 5 嵌套 spawn | `row5-level2/3.json`、`row5-detached.json` 原始数据实读：三层嵌套 + setsid 分离子进程的 pid/net/user namespace ID **完全一致**（pid:[4026533776] 等）；宿主侧回收后零存活（含分离进程） | 拦截（但裁定逻辑有缺陷，见 §4-2） |
| 6 插件/全局 MCP | tmpfs HOME 下 `$HOME/.zcode` 不存在（结构隔离，报告如实区分设计 vs 拦截）；绑定路径仅两份 provider 配置元数据；"插件等价"子进程写→EROFS、读凭据→ENOENT、网络→拒绝、ns 与宿主进程树一致 | 拦截 |
| 7 容器逃逸路径 | `unshare --mount`、`nsenter setns` → EPERM；`/proc/1/comm`=bwrap（pidns init 非宿主 systemd）；docker.sock、/sys 不存在；/dev 仅四个设备节点；CapEff=0x400（仅 NET_BIND_SERVICE）+ NoNewPrivs=1；写 ld.so.preload → EROFS。注：mount 项实际观测为"mount point does not exist"（exit 32），报告写"EPERM"系原因文字不精确——拦截裁定本身成立（CapEff 无 SYS_ADMIN + 根只读，任何 mount 均不可能成功） | 拦截 |
| 8 生命周期 | (a) 探测不可用 → NOT_IMPLEMENTED 拒绝启动；(b) CLI 损坏 → uncertain、intent 保留；(c) createSession 进行中 SIGKILL bwrap → 在途调用 uncertain 且宿主非沙箱 zcode 进程 = 0；(d) 回收零残留。四项全过、零模型支出 | 拦截 |

**边界加强核验**（本增量唯一代码改动）：`buildBwrapArgs` 的 `--tmpfs /`（置于一切根填充绑定之前）+ `--remount-ro /`（收尾）实读在位；沙箱单测含 root-ro 存在性与挂载次序断言；行 4 真实模型轮在根只读边界内完成即白名单区正向对照。`docs/zcode-connector-tools.md` §4.5 根只读语义与 `docs/toolchain.md` 注意点 5 已落档。

## 3. 独立验证（第一手）

1. **矩阵整体重跑**：本机实跑 `b5-2-escape-matrix.mjs`（生产同参数 `createSandboxLaunch`，行 1/2/3/5/6/7，零模型成本）——**41 项裁定、0 失败、exit 0**，与开发方 `1-escape-matrix.log` 逐项一致，完全可复现。
2. **独立门禁**：`npm run check` 实跑——41 文件 / **433 测试全部通过**，exit 0（与开发方 `full-check.log` 433/433 一致；含沙箱单测 14 项）。
3. **原始证据抽验**：`escape-results.json`、row5 三个 ns JSON、row6-fake-mcp.json 逐文件实读；行 4/行 8 脚本的关键断言逻辑（宿主侧存在性断言、非沙箱进程计数）实读确认。
4. 声明纪律：四项隔离仍全 false（翻转属 B5-4，还需 B5-3 全链）。

## 4. 问题与跟进项

1. **N1 — P3，cgroup 资源限制裁定（B5-1 验收遗留，B5-2 未裁定——本验收补裁定）**：toolchain.md 与 §4.5 仍写"留 B5-2 裁定"，B5-2 报告未给出裁定，属我上轮明令"不得无声放过"的事项。**验收方现裁定：cgroup 资源限制（CPU/内存/pids 上限）不是四项隔离声明的必要条件**——隔离语义是效果边界（上下文/写入/结果/能力范围），边界对全进程树的覆盖已由 pidns+userns+netns+根只读强制并经行 5/7 实证；资源耗尽属资源控制关注点，由 RoleDock 层支出前预算与取消（B4 已验收证据）及宿主侧进程管理覆盖；cgroup 上限保持为可选加固项，留 B5-3 后按需立项。ADR-0012 §2 "pid/cgroup 边界覆盖全部子进程"的意图由 pid namespace 覆盖满足。修复要求：B5-3 更新 toolchain.md cgroup 行与 §4.5 cgroup 行，把"留 B5-2 裁定"替换为本裁定结论。复验：读两处文档。
2. **N2 — P3，行 5 重跑守卫存在空真通过路径（必须在 B5-3 修复）**：驱动脚本的 namespace 解析正则（`kind=\[…]`）与 JSON 实际格式（`pid=pid:[…]`）不匹配，三层身份全部显示 "(missing)"，而裁定条件"三层数组一致"对全 missing 空真通过——若未来沙箱回归导致 ns 数据缺失，行 5 会假 PASS。本轮裁定的真实性不受影响（原始 JSON 中三层 + 分离子进程 ns ID 确凿一致，本验收方逐文件亲验），但证据集作为声明翻转后的常备守卫不得有虚过路径。修复要求：B5-3 修正正则以匹配实际格式，并把"解析失败"改为显式失败（`identityOf` 返回 null 时裁定 false）；修后重跑矩阵确认 41 项仍全过。复验：重跑 `b5-2-escape-matrix.mjs` 并人工核对行 5 detail 不再是 "(missing)"。
3. **N3 — P4，报告文字两处不精确（记录在案，无需改代码）**：(a) 报告"沙箱单测 14→15 项"实为 13→14（两份门禁日志与我方独立运行均为 14 项/总量 433）；(b) 行 7 "mount → EPERM"实际观测为 mount point 不存在。两处均不影响裁定有效性。

## 5. 结论与后续

**PASS**。§4 逃逸矩阵八行全部真实执行、全数拦截、零逃逸，证据集可重跑且本验收方独立复跑一致；根只读边界加强已实证并落档。四项隔离声明仍不翻转——按 ADR-0012，翻转属 B5-4，前提是 B5-3 全链复验（10 重叠请求 + 收件箱采纳）经独立验收，且 §4-1/§4-2 两项跟进完成。**B5-3（请求链受管接入）可开工。**
