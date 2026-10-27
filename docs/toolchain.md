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

## P6-G0 桌面技术定档（2026-10-25）

按 `docs/DESKTOP_GUI_PLAN.md` §4/§8 与 ADR-0013 的 G0 决策门，以可运行探针（真实窗口/进程/打包产物）完成定档。新增依赖均为 `@roledock/desktop` devDependencies（探针、构建与 E2E 用），渲染层零运行时框架依赖。证据见 `phase-reports/evidence/2026-10-25-p6-g0/`。

| 组件 | 定档 | 核查依据 |
| --- | --- | --- |
| 桌面容器 | **Electron 44.9.3**（精确） | `npm view`：45.0.0 发布仅 4 天（2026-10-21），按仓库稳定线惯例取上一稳定大版本最新补丁 44.9.3（同 43/44/45 官方支持窗口）；engines `node >= 22.12.0`；二进制经官方 GitHub release 下载，`electron --version` → v44.9.3 |
| 外壳运行时边界 | Electron 自带 Node **24.22.0** 仅作 shell，**不得**用于工作空间服务 | 探针实测 `process.versions`（electron 44.9.3 / node 24.22.0 / chrome 152）；服务子进程强制用锁定 Node 22.23.2 |
| 渲染层 | **无框架 TypeScript + DOM**（延续 G-min 零运行时依赖哲学）；组件为可测试 TS 模块 | DESKTOP_GUI_PLAN §4"前端使用 TypeScript 模块和可测试组件"；G0 决策（用户确认） |
| 构建器 | **esbuild 0.28.2**（唯一构建器；main/preload/renderer 及 service、MCP 子进程单文件 bundle） | `npm view` 最新稳定；注意点：嵌入 `@roledock/protocol` 的 bundle 必须放 `vendor/` 且同级上一层放 `schemas/`（协议按 `import.meta.url` 相对读 Schema）；ESM bundle 需 `createRequire` banner（cross-spawn 等动态 require） |
| E2E | **@playwright/test 1.64.1**（`_electron.launch` 驱动真实窗口；不需要浏览器下载） | `npm view` 最新稳定；engines `node >= 20` |
| 打包 | **electron-builder 26.18.0**；`dir`=解压即跑开发产物（已验证），**`.deb`=唯一首发安装格式候选**（G7 出包） | `npm view`；deb 实测可出包（133 MB）；怪癖：npm scope 输出子目录需预创建（fpm 不自建父目录）；metadata 需 homepage（占位 `https://roledock.example`，真实主页 P6-R 前定） |
| MCP 客户端（探针握手用） | **@modelcontextprotocol/sdk 1.32.1**（复用已锁版本） | 与 packages/mcp 同版本，无新增传递依赖线 |
| 服务运行时获取 | 官方 dist `node-v22.23.2-linux-x64.tar.xz` + 官方 SHASUMS256.txt SHA256 校验（`scripts/fetch-runtime.mjs`），dev 缓存 `.cache/runtime/`、打包进 `resources/runtime/node/`（附 LICENSE） | nodejs.org 官方分发；校验通过 |

安装与代理注意（本机 `http_proxy=127.0.0.1:17891`）：

- electron 的 postinstall/懒下载走 `@electron/get` 5.1.0，其 Node fetch **不读** 代理 env——需 `ELECTRON_GET_USE_PROXY=1`（undici EnvHttpProxyAgent，官方开关）才可下载；electron-builder 的 app-builder（Go）遵循 HTTPS_PROXY，无需额外设置。
- `npm audit fix` 后 **0 漏洞**（修复 body-parser GHSA-27r3-jxmh-p828 与 fast-uri 4 项公告，均 electron-builder 传递依赖、dev 工具链；package-lock.json 已更新）。
- 新增 npm scripts：`desktop:runtime`（获取校验 Node 运行时）、`desktop:build`（tsc -b + esbuild 探针 bundle）、`desktop:probe`（dev 探针，真实窗口）、`desktop:e2e`（Playwright 真实窗口全生命周期）、`desktop:package`（dir 打包）。这些命令自 G0 起存在（计划 §16 的"当前不存在"状态解除）。
- 契约与生命周期矩阵见 `docs/spec/desktop-gui-contract.md`；探针产物路径与单 writer/生命周期实测见 `phase-reports/evidence/2026-10-25-p6-g0/`。

## P6-G1 桌面外壳增量（2026-10-26）

- **共享包变更**：`ServiceClient.call` 增加 `options.timeoutMs`（默认 30s）客户端等待期限，超时拒绝本地 `ServiceRequestTimeoutError`（不进协议错误码注册表；语义=已提交动作需对账，不盲重试）。全部现有消费者行为兼容（默认期限不短于既有 service 30s 服务端超时）。
- **shell 构建**：新增 `scripts/build-shell.mjs`（产物 `dist-desktop/shell/{main.mjs,preload.cjs,renderer/}`，vendor/schemas 布局与探针一致）与 `scripts/shell.mjs`（dev 启动器，env `ROLEDOCK_SHELL_NODE`）；`desktop:build:shell / desktop:shell / desktop:e2e:shell / desktop:package:shell`。打包配置 `electron-builder.shell.yml`（独立于冻结的探针配置；`extraMetadata.main` 覆盖，产物 `dist-app-shell/`）。G0 探针的 `src/probe/**`、`scripts/build.mjs`、`electron-builder.yml` 冻结不动。
- 新 E2E 配置 `playwright.shell.config.ts`（`test/e2e-shell/`）；shell 对话框 fixture env `ROLEDOCK_SHELL_DIALOG_FIXTURE`、userData 隔离 env `ROLEDOCK_SHELL_USER_DATA`（均为文档化测试钩子）。
- G-min 模块化：决策逻辑提取至 `packages/desktop/src/gmin/confirm.ts`；`src/index.ts`（loopback 诊断入口）行为不变（既有 3 项测试回归通过），与 shell 生产确认页共享该模块。
- 证据：`phase-reports/evidence/2026-10-26-p6-g1/`。

## P6-G2 工作空间/角色增量（2026-10-26）

- **共享包依赖变化**：`@roledock/service` 新增工作区依赖 `@roledock/adapter-zcode`（bin 级 launcher 构造真实 adapter；core 注入点不变），锁文件更新。
- **service bin 新模式**：`roledock-service --workspace-config <config.json> <root>`——bin 内完成 connector 握手（`connectZCodeConnector`，惰性 app-server，零会话零模型轮）→ `ZCodeAdapter` 构造（`stateDir=<root>/.roledock/zcode-adapter`）→ `WorkspaceService.start`；退出 `closeJournal`+`disconnect`。config JSON（桌面写 `<root>/.roledock/launcher-config.json`，0600）：`{kind:"zcode", cliPath, connectorPath, credentialHelper?, provider?, model?, managed?{egress[]}, journalPath?}`——仅路径与标识，无凭据。`--mock-workspace` 模式保留（诊断）。
- **桌面**：vendor 新增 `zcode-connector.mjs`（reference-bin bundle）；`@roledock/adapter-zcode` 包入口补只读预检导出（`probeSandboxRunner`/`planEgress`，纯函数）。新 shell 命令无工具链版本变化。
- 新协议 Schema：`role-details`、`policy-list`、`workspace-runtime-status`（+G1 的 `workspace-service-info`），全部注册并已在 service 传输边界校验。
- 证据：`phase-reports/evidence/2026-10-26-p6-g2/`。
