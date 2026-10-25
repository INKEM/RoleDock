# 环境基线（P0 固定）

日期：2026-10-12
原则：所有工具链版本经实际环境与官方资料核查后**精确固定**（不用浮动 latest），锁文件（package-lock.json）入库。变更须修订本文件并在 P0 报告记录理由。

## 已固定的版本

| 组件 | 版本 | 固定方式 | 核查依据 |
| --- | --- | --- | --- |
| Node.js | 22.23.2 | `.nvmrc` + 根 `engines.node`（`.npmrc` 开启 `engine-strict=true`） | 本机 nvm 唯一已装版本；22.x 为现行 LTS |
| npm | 10.9.8 | `engines.npm >= 10.9.8` | 随 Node 22.23.2 附带 |
| TypeScript | 5.9.3 | 根 devDependencies 精确版本 | `npm view typescript@5 version` 的 5.x 最新（7.x 原生线不采用，保持稳定线） |
| vitest | 5.0.4 | 根 devDependencies 精确版本 | `npm view vitest version`（registry 最新稳定） |
| ajv | 8.20.0 | `@roledock/protocol` dependencies 精确版本 | 原生支持 JSON Schema draft 2020-12 |
| ajv-formats | 3.0.1 | `@roledock/protocol` dependencies 精确版本 | ajv 8 官方格式校验插件（date-time 等） |
| @types/node | 22.20.5 | 根 devDependencies 精确版本 | 与 Node 22 对应的类型线 |
| SQLite | Node 内置 `node:sqlite` | 无第三方依赖，随 Node 版本固定 | 见下节冒烟验证 |
| git | 2.34.1 | （本机环境记录，不强制） | 提交与基线管理 |

## SQLite 选型说明

选择 Node 22 内置 `node:sqlite` 而非 better-sqlite3：

- 零原生依赖：无需 node-gyp/预编译二进制下载，干净检出即可安装，符合"独立开源、干净环境可复现"目标。
- 官方文档（Node v22 API，`node:sqlite`）：22.13.0 起不再需要 `--experimental-sqlite` 标志；稳定性索引 **1.1（Active development）**。配合精确固定的 Node 22.23.2，API 行为可复现；实验状态已在此声明，P1 落库实现时如有 API 变更，在此记录并评估回退 better-sqlite3。
- 覆盖原型需要：同步 `DatabaseSync`（`exec`/`prepare`/事务）满足单协调器（ADR-0001）的存储需求。

### 冒烟验证记录（2026-10-12，Node 22.23.2）

```text
$ node -e "…DatabaseSync(':memory:')…"
select: [{"id":1,"v":"hello"}]
after rollback: {"n":1}
(node:…) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

验证内容：内存库建表（STRICT）、预编译插入、查询、显式事务回滚。结果符合官方文档行为；实验警告符合稳定性 1.1 的预期。

### 锁行为验证（P1，2026-10-12）

单协调器约束（ADR-0001）采用 `PRAGMA locking_mode = EXCLUSIVE` 的主连接持有文件锁：

- 同进程第二连接：打开成功（SQLite 延迟加锁），首条语句抛 `errcode: 5`（SQLITE_BUSY）→ 映射为 `WORKSPACE_LOCKED`。
- 跨进程：持锁进程存活期间，另一进程首条语句同样 `errcode: 5`；进程退出（含 SIGKILL）后 OS 立即释放文件锁，重新打开成功，无陈锁。
- 以上行为由 `tests/integration/workspace-lock.process.test.ts` 以真实子进程持续验证。

## 网络与注册表

- npm registry `https://registry.npmjs.org/` 可达，`npm view` 查询正常（TypeScript/vitest/ajv/@types/node 均现场核查）。
- 本机无 `.npmrc` 镜像/代理配置；仓库 `.npmrc` 仅含 `engine-strict=true`。

## 命名核查记录（P0 任务 1）

| 名称 | 状态 | 证据（2026-10-12 查询） |
| --- | --- | --- |
| npm 包 `roledock` | 未占用 | `registry.npmjs.org/roledock` → 404 |
| npm scope `@roledock` | 未占用 | registry 与 npmjs 站点均 404 |
| npm 包 `roledock-core` | 未占用 | registry 404 |
| GitHub 仓库 `roledock` | 无同名仓库 | 全站 `roledock in:name` 仅 2 个模糊匹配 |
| GitHub 组织 `github.com/roledock` | **已被第三方占用** | 空组织（仅一个空仓库 `app`），无法注册同名组织 |

结论：npm 侧名称可用；GitHub 组织名不可用为**待确定项**（正式发布前需要用户确定托管组织/仓库位置），本轮不创建任何远程仓库。

## 复现命令

```bash
nvm use            # 读取 .nvmrc → 22.23.2
npm ci             # 按 package-lock.json 精确安装
npm run check      # typecheck（tsc -b --force + 全量 noEmit 检查）→ build → test
```

## P5-A MCP 与共享服务增量（2026-10-14）

新增工作区包 @roledock/service 与 @roledock/mcp；Node 22.23.2/内置SQLite基线保持。

- 官方 MCP TypeScript SDK `@modelcontextprotocol/sdk` **1.32.1**，直接依赖精确固定；npm registry现场返回engines `>=18`、官方repository及tarball完整性，见 [查询记录](phase-reports/evidence/2026-10-14-p5-a/npm-sdk-metadata.json)。
- 根据[官方v1服务端文档](https://ts.sdk.modelcontextprotocol.io/server)、[官方发布记录](https://github.com/modelcontextprotocol/typescript-sdk/releases)及本地已安装声明核查，使用Server、ListToolsRequestSchema/CallToolRequestSchema、StdioServerTransport/StdioClientTransport。本阶段选用受维护v1单包线；不推测v2 API。
- SDK及其传递依赖由package-lock.json锁定；未直接引入Zod API。安装使用 `npm install --ignore-scripts`，现场audit为0漏洞；最终复现按 `npm ci` 精确安装。

## 沙箱 runner 定档（B5-1，2026-10-25）

按 [ADAPTER_SANDBOX_PLAN](ADAPTER_SANDBOX_PLAN.md) §5 的选型要求，B5-1 对本机（Ubuntu 22.04.5 LTS，内核 6.8.0-147-generic）做了只读探测与真实运行验证后定档：

| 组件 | 定档 | 核查依据 |
| --- | --- | --- |
| 沙箱 runner | **bubblewrap 0.6.1**（Ubuntu 22.04 发行版包） | 本机 `/usr/bin/bwrap`；非特权 userns 可用（`kernel.unprivileged_userns_clone=1`、`user.max_user_namespaces=124252`）；所需 flag（`--unshare-user/pid/net/ipc/uts`、`--unshare-cgroup-try`、`--cap-add`、`--die-with-parent`、`--new-session`、`--proc`、`--tmpfs`、`--ro-bind(-try)`、`--dev-bind`、`--symlink`、`--bind`、`--clearenv`、`--setenv`）全部验证 |
| 出口白名单 | 伪 loopback IP + hosts 钉扎 + 沙箱内中继 + Unix socket 宿主转发器（`adapters/zcode/src/sandbox.ts`） | 不依赖 slirp4netns/pasta/podman（本机均未安装，缺失不阻塞）；iptables 不需要；TLS 端到端不 MITM。真实模型轮经白名单完成（证据 `phase-reports/evidence/2026-10-24-p5-h-b5-1/1-chain.log`） |
| 内核前提 | 非特权 user namespace 开启 | `sysctl kernel.unprivileged_userns_clone`；探测失败即 NOT_IMPLEMENTED（失败关闭） |
| cgroup 资源限制 | **裁定（B5-2 验收 §4-1，B5-4 落档）：cgroup 资源上限不是四项隔离声明的必要条件**；pidns+userns+netns+根只读边界覆盖已实证（B5-1 真实链 + B5-2 逃逸矩阵全拦截）。cgroup CPU/内存/pids 上限保持**可选加固项**（`--unshare-cgroup-try` 已在位），未强制不构成声明缺口 | pid namespace 边界已由 `--unshare-pid --die-with-parent` 强制；逃逸矩阵（B5-2，验收方独立重跑一致）决定 cgroup 非必要条件 |

已验证的内核/bwrap 行为注意点（实现中已规避，回归时勿回退）：

1. bwrap 按参数次序应用挂载，后挂载会遮蔽同子树上的先挂载——父子路径必须父先子后（`buildBwrapArgs` 中 tmpfs /tmp → runtimeDir 绑定 → tmpfs home 的次序不可调换）。
2. bwrap 的 `--dev /dev`（tmpfs devtree）在本内核上使**特权端口绑定**（443/80）一律 EACCES，与 `--cap-add` 无关——改用 `--dev-bind` 逐节点提供 `/dev/null|zero|random|urandom`。
3. bubblewrap 自动拉起新 netns 的 loopback，无需 `ip link set lo up`（沙箱内无 CAP_NET_ADMIN，冗余 setlink 会 EPERM）。
4. 特权端口绑定仅需 `--cap-add CAP_NET_BIND_SERVICE`（对沙箱自有 netns 生效）。
5. 根文件系统可整体只读：`--tmpfs /`（必须在一切根填充绑定之前）+ 全部挂载后 `--remount-ro /`（0.6.1 支持，非递归——子挂载保持自身读写标志）。白名单区之外的一切写入 EROFS/ENOENT；`--proc /proc` 等子挂载必须放在 `--tmpfs /` 之后，否则被新根覆盖（B5-2 实证）。

runner 探测语义见 `docs/zcode-connector-tools.md` §4.5；探测不可用即 `NOT_IMPLEMENTED`（失败关闭，`ROLEDOCK_SANDBOX_PROBE=unavailable` 诊断覆盖仅允许更严格方向）。
- 共享传输使用Node内置http over Unix socket（0600），仅验证Linux；无新桌面容器或真实宿主SDK。

官方SDK的两个真实stdio子进程与本地共享服务互通由packages/mcp/test/mcp.test.ts验证；这不是已授权真实Harness证明。

## P5-H ZCode 受限接入（2026-10-14）

用户指定ZCode；Linux本机实际Desktop为3.15.3（安装包package.json），bundled CLI为**0.16.9**（`node /opt/ZCode/resources/glm/zcode.cjs --version`和doctor），CLI内runtime包装元数据另为0.13.3。CLI在现有Node22.23.2上实跑，RoleDock不升级Node基线。

现有MCP连接器zcode-delegation **0.1.0** 由用户已有配置提供，账户模型实测 **GLM-5.3**，provider标识account:bigmodel-team-coding-plan。该连接器不是官方ZCode SDK，也不是RoleDock自建模型宿主。版本/本地源码哈希见 [组件清单](phase-reports/evidence/2026-10-14-p5-h/host-components.sha256)、[doctor](phase-reports/evidence/2026-10-14-p5-h/zcode-doctor.json)。未复制其账户实现或凭据到仓库。

新增@roledock/adapter-zcode复用官方MCP SDK **1.32.1**，直接依赖精确固定，锁文件更新无新浮动直接依赖。官方CLI入口参考[源码](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/cli/src/run.ts)，事件及工具传输参考[Hooks](https://zcode.z.ai/en/docs/hooks)/[MCP](https://zcode.z.ai/en/docs/mcp-services)；具体能力以本机证据和受限声明为准。

真实模型诊断已运行；P5-H要求的角色锚定/隔离/取消/对账闭环仍未证实，不关闭G01。见[接入说明](zcode-integration.md)。

## G-min 桌面确认面技术基线(2026-10-24)

ADR-0011 将 GUI 最小授权确认面自 P6-G 提前;按 ADR-0007 的留白,本基线以**可运行性优先、零新增依赖**落定:

- 交付载体:新增工作区包 `@roledock/desktop`(bin `roledock-desktop-gmin`),Node 内置 `node:http`,页面为内嵌纯 HTML/JS(无框架、无外部资源),绑定 127.0.0.1。
- 信任分割(ADR-0007 边界):该 Node 进程是受信所有者客户端——持有 owner 凭据(读取 service 写出的 `owner-connection.json`,校验属主与 0600),只代理三个操作(`externalSessions.list`/`roles.list`/`authorizations.submitHumanEvent`);浏览器页面是渲染层,不见凭据、无写库、无宿主命令。
- 桌面容器(Electron/Taur 等)与完整五页面仍留待 P6-G 正式阶段选择;本基线只验证"本地 GUI ↔ 受信 owner 进程 ↔ 共享服务"的 IPC 形态(同机 loopback HTTP + Bearer)。
- 证据:真实 ZCode 会话上 GUI 确认 → recordHuman(human-event)→ 锚定全链,见 `phase-reports/evidence/2026-10-24-p5-h-gmin/`。
