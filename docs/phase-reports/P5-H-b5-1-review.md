# P5-H 增量 B5-1 独立验收：沙箱执行器技术验证（受管执行最小真实链）

日期：2026-10-25
验收方：独立验收 Agent；未修改产品实现；独立验证未发送新模型任务（复用开发方证据日志 + 零模型轮次的第一手沙箱实证）
结论：**PASS**

## 1. 范围与基线

验收对象为 ADAPTER_SANDBOX_PLAN §3 第二增量 B5-1，开发报告 `P5-H-b5-1-development.md`。基线与 B5-0 相同；经 mtime 核验自 B5-1 门禁证据（2026-10-25 00:42）后无任何源码改动，本报告即验收最终树。

## 2. 逐项核验

| 退出条件（计划 §3 B5-1） | 实际行为与证据 | 判定 |
| --- | --- | --- |
| runner 选型定档 | `docs/toolchain.md` §沙箱 runner 定档实读：bubblewrap 0.6.1（发行版包）、非特权 userns 前提、所需 flag 全验证、三个内核事实防回归（挂载次序遮蔽、`--dev` devtree 使特权端口绑定 EACCES、bwrap 自动拉起 netns loopback）；不依赖 slirp/iptables/容器运行时。 | 满足 |
| 沙箱内完成模型轮 | `1-chain.log` 实读：裸会话 `sess_4578fbb4…` 创建 → 1 个真实模型轮在沙箱内完成（`SANDBOX-MODEL-TURN-OK`，usage 由 provider 报告，GLM-5.3，模型 API 头经既有 helper RPC 注入）。 | 满足 |
| 无 owner 凭据进沙箱 | 三重结构证据：`--clearenv` 后 env 仅 10 个白名单键（本验收方第一手复验一致，见 §3）；挂载清单 22 条全白名单、`forbidden_mount_hits:[]`、无 `$HOME` bind（HOME 为 tmpfs）；凭据仅经 helper RPC 走 stdio（B3 既有机制）。`buildBwrapArgs` 单测断言 argv 不含 credentials、`--dev` 不出现。 | 满足 |
| runner 缺失路径 NOT_IMPLEMENTED | `probeSandboxRunner`：存在性 + 版本 + 以真实 namespace 集合功能干跑；`runReferenceConnector` 启动前探测、不可用即 NOT_IMPLEMENTED 信封退出（先于 transport 建连）。`ROLEDOCK_SANDBOX_PROBE=unavailable` 覆盖只允许"更严格"方向。单测注入不可用 runner + 真实 bin 进程测试（机器自适应）双覆盖。 | 满足 |
| 并发 2–3 实例烟测 | `2-concurrency.log`：3 个独立实例并行各自完成裸会话 + 真实模型轮（答案均 `CONCURRENT-SANDBOX-OK`），墙钟 13.9s，结束全部回收。 | 满足 |
| 进程树回收 | `1-chain.log`：运行期 2 个沙箱进程、断开后 0（两脚本均断言）；`--die-with-parent` + pidns + 连接器进程组 kill。本验收方第一手复验见 §3。 | 满足 |

实现面抽查（实读）：`sandbox.ts` 拓扑与声明一致——无根 bind（仅 /usr、/etc/ssl、生成 hosts、逐节点设备、CLI/provider 配置两文件、node 目录、runtime 目录 ro；workspace rw；/tmp 与 HOME tmpfs）；出口白名单=伪 loopback IP + hosts 钉扎 + 沙箱内中继 + 宿主转发器**二次校验**（`EgressForwarder` 对白名单外目标拒断并计数，单测断言拒绝）；`spawnSandboxed` env 仅 PATH，父进程环境不进沙箱；连接器 0.4.0、工具集未变；适配器能力声明与核心零改动（grep 确认 isolation 四项仍 false；core/protocol/service/desktop 自 B4 门禁证据后无源码改动）。

## 3. 独立验证（第一手，零模型轮次）

1. **独立门禁**：本机实跑 `npm run check`（Node 22.23.2）——typecheck 通过，**41 文件 / 432 测试全部通过**，exit 0（含 sandbox.test.ts 13 项、reference-connector.process.test.ts 3 项；本轮无超时，与开发方 `full-check.log` 432/432 一致）。
2. **受管拉起实证**（复用 dist 产物，不花模型轮次）：以 `--sandbox`（空出口白名单）真实连接器拉起沙箱 → `zcode_create_session` 建裸会话成功 → 沙箱内 supervisor 写出的 `supervisor.log` 显示 `app-server-start pid=12`（低 PID 直接证明真实 pid namespace）与 `loopback-present`、`relay-ready` → 沙箱内 `env-keys.json` 恰 10 个白名单键 → 断开后精确特征（`bwrap --unshare`）进程计数回到基线，进程树完全回收。增量计数（基线+2 → 回收）与开发方链日志一致。
3. **探测与出口白名单纯函数**：`probeSandboxRunner` 本机实测 `available:true, bubblewrap 0.6.1`（功能干跑通过）；`planEgress` 拒绝裸 IP/畸形条目、按序映射伪 IP，实测一致。

## 4. 问题与边界记录

1. **N1 — P3，cgroup 资源限制未强制（诚实推迟，不阻塞）**：计划 §2 设计规则与 ADR-0012 写"pid namespace + cgroup 边界覆盖全部子进程"。B5-1 交付 pidns 边界（已实证覆盖全进程树）+ `--unshare-cgroup-try`，cgroup **资源限制**（CPU/内存上限）未强制；toolchain.md 与报告 §5.4 如实记录，是否为强制项留给 B5-2 逃逸矩阵裁定。隔离语义（边界覆盖）已满足，资源限制属加固项——B5-2 必须对矩阵 #5/#7 给出明确裁定并记录，不得无声放过。
2. **白名单范围**：e2e 显式传入两个 provider 端点域；配置化传入、不硬编码符合计划 §5。单工作空间语义（连接器 cwd 为唯一 rw 根）为如实边界，多工作空间处理属 B5-3。
3. **非白名单端点拦截**的结构性失败路径（矩阵 #3）与容器逃逸常见路径属 B5-2，本增量未验证——与报告声明一致。
4. 测量方法注记：验收方首版自写脚本的进程计数出现基线自匹配假象（脚本文本进 bash 命令行），已用精确特征与文件化脚本排除；不影响产品代码，开发方证据脚本（文件化运行）无此问题。

## 5. 结论与后续

**PASS**。受管执行机制可行 + 最小真实链跑通已第一手确认；本增量通过不构成任何隔离声明——四项隔离仍 false，逃逸拦截测试（B5-2 逃逸矩阵）、请求链受管接线与 05H 步骤 7–8 复验（B5-3）、声明翻转与收口（B5-4）待续。B5-2 可开工，须先裁定 N1。
