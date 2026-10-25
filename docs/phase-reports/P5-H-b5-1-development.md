# P5-H-b5-1 开发报告:沙箱执行器技术验证(受管执行最小真实链)

日期:2026-10-25;状态:**待独立验收**。

按 [ADR-0012](../adr/0012-adapter-enforced-isolation.md) 与 [ADAPTER_SANDBOX_PLAN](../ADAPTER_SANDBOX_PLAN.md) §3 执行 P5-H 增量 B5 系列第二增量 B5-1。前置:B5-0 独立验收尚待进行(所有者指示连续续作,B4 报告同款声明)。本增量交付 runner 选型定档与受管模式最小真实链——**沙箱内完成真实模型轮**;不翻转任何隔离声明(翻转属 B5-4),不做逃逸测试矩阵(属 B5-2),不接线 requests executor(属 B5-3)。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(同一工作区,含 B0–B4/G-min/B5-0 未提交改动;`evidence/2026-10-24-p5-h-b5-1/baseline-head.txt`)。
- 官方 CLI 入口 sha256 `97490d0f…`、参考连接器与 helper 哈希见 `evidence/2026-10-24-p5-h-b5-1/host-components.sha256`;无新 npm 依赖(沙箱执行器仅用 node 内置模块 + 系统 bubblewrap)。

## 2. runner 选型定档(已落档 `docs/toolchain.md` §沙箱 runner 定档)

本机只读探测(2026-10-25,Ubuntu 22.04.5,内核 6.8.0-147-generic):bubblewrap 0.6.1 在位且所需 flag 全支持;非特权 userns 开启;slirp4netns/pasta/podman 缺失、iptables-nft 在位但不需要;docker 29.9.2 在位但不用(守护进程依赖重)。**定档:bubblewrap 0.6.1 + 伪 loopback IP/hosts 钉扎/Unix socket 转发的出口白名单拓扑**(不依赖 slirp/iptables/容器运行时)。三个实现层内核事实经实证并写入 toolchain.md 防回归:bwrap 挂载次序遮蔽(父子必须父先子后)、`--dev /dev` tmpfs devtree 使特权端口绑定 EACCES(与 cap 无关,改逐节点 `--dev-bind`)、bwrap 自动拉起 netns loopback(无需 `ip link set lo up`,沙箱内无 CAP_NET_ADMIN)。

## 3. 交付与退出条件对应

| 退出条件(ADAPTER_SANDBOX_PLAN §3 B5-1) | 交付与证据 |
| --- | --- |
| 真实运行日志 | `evidence/2026-10-24-p5-h-b5-1/1-chain.log`(JSONL 全链)、`2-concurrency.log`(3 并发)、`sandbox-evidence/`(沙箱内 supervisor 写出的 env-keys.json / mounts.txt / supervisor.log)、`host-components.sha256` |
| 沙箱内完成模型轮 | 裸会话 `sess_4578fbb4…` → 1 个真实模型轮(low reasoning)在沙箱内完成,答案 `SANDBOX-MODEL-TURN-OK`,usage 由 provider 报告(GLM-5.3,account:bigmodel-team-coding-plan,provider 头经既有 helper RPC 注入);1-chain.log |
| 无 owner 凭据进沙箱 | 三重结构证据:①`--clearenv` 后 env 仅 10 个白名单键(沙箱内实测,`env-keys.json`——无 token/secret/账户存储路径);②挂载清单 22 条全为白名单(无 `$HOME` bind、无 credentials.json、无 owner-connection;`forbidden_mount_hits:[]`);③凭据仅在 helper RPC 应答内经 stdio 流入 app-server 进程内存(B3 既有机制,不经 FS/env/mount) |
| runner 缺失路径如实 NOT_IMPLEMENTED | 探测(存在性+版本+真实 namespace 干跑)不可用 → 连接器启动前 `NOT_IMPLEMENTED` 信封退出;单测注入不可用 runner + 真实 bin 进程测试(`ROLEDOCK_SANDBOX_PROBE=unavailable`,机器自适应)双覆盖;sandbox.test.ts 13 项 + reference-connector.process.test.ts 3 项全过 |
| 并发 2–3 个沙箱实例烟测通过 | 3 个独立实例(各自连接器/沙箱 runtime/转发器/工作空间/journal)并行,各自完成裸会话+真实模型轮,答案均 `CONCURRENT-SANDBOX-OK`,墙钟 13.9s,结束后全部回收;2-concurrency.log |
| (链路要求)进程树回收 | 运行期 2 个沙箱进程,断开后 0(两个脚本均断言);`--die-with-parent` + pidns + 连接器进程组 kill |

连接器版本 0.3.0 → **0.4.0**(受管 spawn 行为实质变化;工具集自 0.3.0 未变)。

## 4. 主要文件与公共接口变化

- `adapters/zcode/src/sandbox.ts`(新):`probeSandboxRunner`(探测+诊断覆盖)、`planEgress`(host[:port]→伪 loopback IP 映射+hosts 文件,纯函数)、`buildBwrapArgs`(挂载次序敏感的 argv 构建,纯函数)、`RELAY_SOURCE`/`SUPERVISOR_SOURCE`(沙箱内中继与 pidns init 模板)、`EgressForwarder`(宿主侧白名单校验+裸管道转发,连接计数/拒断计数)、`createSandboxLaunch`/`spawnSandboxed`。
- `adapters/zcode/src/reference-connector.ts`:options.sandbox 改为 `{ egress: readonly string[] }`;`runReferenceConnector` 启动前探测(不可用即 NOT_IMPLEMENTED);`AppServerClient.start()` 受管分支走 bwrap spawn(cwd=连接器工作空间为唯一 rw 根;env 白名单注入含两个 provider 配置文件路径),子进程退出时停转发器;启动时向 stderr 记一行 `roledock-sandbox-launch`(runtimeDir+完整 argv,仅路径无凭据)。
- `adapters/zcode/src/reference-bin.ts`:新增 `--sandbox-egress`(可重复 string)。
- `adapters/zcode/test/sandbox.test.ts`(新,13 项)+ `reference-connector.process.test.ts`(B5-0 测试改造为 `ROLEDOCK_SANDBOX_PROBE=unavailable` 机器自适应;默认关闭路径不变)。
- 文档:`docs/toolchain.md`(沙箱 runner 定档节)、`docs/zcode-connector-tools.md` §4.5(草案→实装语义)、`docs/zcode-integration.md` 状态行。适配器能力声明与核心零改动。

## 5. 失败、边界与未验证项

1. **开发中修复(均有实证,详见 toolchain.md 注意点)**:①bwrap 挂载次序遮蔽导致首次真实链失败(runtimeDir 绑定被后置 `--tmpfs /tmp` 覆盖,supervisor 不可见)——重排为父先子后;②`--dev /dev` 使 443/80 绑定 EACCES(与 `--cap-add` 无关,cap 集实测在位)——逐节点 `--dev-bind` 替代;③supervisor 冗余的 `ip link set lo up` 因沙箱内无 CAP_NET_ADMIN 而 EPERM 误杀链路——删除(bwrap 自动拉起 loopback);④relay/supervisor 模板把配置路径当 JSON 串解析——改 readFileSync。
2. **诚实边界**:本增量证明的是"受管执行机制可行 + 最小真实链跑通",**不构成任何隔离声明**——四项隔离仍全 false,逃逸拦截(写/读/网络/嵌套进程)未测试(B5-2 逃逸矩阵),`capability_scope`/`temp_dir` 在受管路径的解锁未做(B5-3)。
3. **白名单范围**:e2e 显式传入两个 provider 端点域(api.z.ai、open.bigmodel.cn——helper 已知两个账户族);按 provider 收窄属 B5-3 材料/策略语义。沙箱为**单工作空间语义**(连接器 cwd 为唯一 rw 根),多工作空间请求的处理属 B5-3。
4. **cgroup 资源限制未强制**:pid namespace 边界已强制;systemd-run --user scope 方案留 B5-2 按逃逸矩阵裁定是否为强制项(toolchain.md 已记录)。
5. **未验证**:非白名单端点拦截的结构性失败路径(B5-2 矩阵 #3;转发器白名单拒断已有单测);容器逃逸常见路径;Windows/macOS(设计不支持)。

## 6. 规范与 ADR 更新

- 无新架构决策(ADR-0012 框架内续作);`docs/zcode-connector-tools.md` §4.5 由 B5-0 草案更新为 B5-1 实装语义;`docs/toolchain.md` 新增沙箱 runner 定档(含防回归注意点);`docs/zcode-integration.md` 状态行更新。
- 测试门禁:zcode 包 16 项(13 sandbox + 3 process)真实运行通过;全量 `npm run check` 结果见 `evidence/2026-10-24-p5-h-b5-1/full-check.log`。

## 7. 下一增量可用输入与未满足退出条件

- **B5-2(逃逸测试证据集)输入**:沙箱执行器已就绪(`--sandbox` 受管 spawn + 白名单拓扑);逃逸矩阵 8 项按 `ADAPTER_SANDBOX_PLAN` §4 固化为 fixture 测试 + 真实沙箱执行证据;宿主转发器拒断计数与 mounts/env 证据可作为矩阵取材点;`--dev` 遮蔽/cap 语义等内核事实已定档防回归。
- **未满足的收口条件**:四项隔离声明仍 false、G01-Z03 仍 BLOCKED、05H 步骤 7–8 仍按设计拒绝——均待 B5-2/B5-3/B5-4;本增量通过不代表隔离证明。
