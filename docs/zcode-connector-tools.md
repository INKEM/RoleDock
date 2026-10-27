# ZCode 连接器工具契约(P5-H 增量 B0 固化)

日期:2026-10-24;状态:B0 契约预留。参考实现为仓库内 `roledock-zcode-reference-connector`(B1 交付);外部连接器(如用户已配置的 zcode-delegation 0.1.0)按本契约对齐。ADR-0010 的约束继续适用:连接器路径一律经 CLI 参数/环境注入,本仓库不硬编码个人路径或账户实现,不读模型凭据。

## 1. 角色与边界

连接器是**受信外部组件**:由受信启动器经 `--connector <路径>` 注入给适配器(`connectZCodeConnector`),作为 MCP stdio 服务器运行,内部与 ZCode 官方 CLI `app-server`(JSON-RPC over stdio)通信。连接器是 ZCode 侧访问与凭据边界;RoleDock 核心与适配器只看结构化工具结果,不接触模型凭据。

## 2. 握手与能力发现

- MCP `initialize` 返回 `serverInfo { name, version }`;适配器记录该版本作为证据(现有行为)。
- **B1 新增**:连接建立后适配器调用标准 `tools/list`,以返回的工具名集合作为连接器能力面。适配器对未声明工具一律 `ADAPTER_CAPABILITY_MISSING`,不猜测对端支持范围。
- 连接器工具集变更必须递增 `version`;适配器按工具逐个门禁,不按版本号推断。

## 3. 凭据与 Provider 注册边界

`interaction/requestProviderRuntimeHeaders` 等账户握手由连接器进程处理。参考连接器**不读取、不解密任何凭据存储**:两类请求都外包给显式指定的凭据 helper(`--credential-helper <可执行命令>`;B3 起支持两种请求形态):

1. `{providerId}` → `{headersApplied, requestAuth?|errorMessage?}`——模型请求头;未配置 helper 或 helper 无该 provider 的键时如实 `headersApplied:false`。
2. `{bootstrap:{builtinPath}}` → `{preferred, params}`——官方 `provider/updateAccountConfig` 的注册参数(**无密钥**,仅 provider 注册表/权益映射);连接器在首个调用前执行一次,并在 app-server 子进程每次(重)启动后重新执行——子进程重启会清空 provider 注册表。

`--provider`/`--model` 指定模型选择(个人值不入仓库);`--provider` 缺省时采用 helper 应答的 `preferred`。未配置 helper 时模型轮次不可用,这是如实失败,不是降级伪装。仅做会话身份验证等零模型操作时无需 helper。

参考连接器 `--journal <sqlite 绝对路径>`(B3):锚定载入的 intent/确认持久 journal(载入协议的崩溃恢复依赖它;app-server 不在 `session/events` 重放 resume 前的历史事件)。

## 4. 工具契约

约定:入参均为必填字段校验;`sessionId` 匹配 `^sess_[\w-]+$`;`workspacePath` 必须是已存在目录。工具结果为单条 JSON 文本内容;错误经 MCP `isError` 文本返回,适配器按 uncertain/INVALID_STATE_TRANSITION 归类。

### 4.1 既有工具(zcode-delegation 0.1.0 已验证行为,参考连接器对齐)

| 工具 | 入参 | 出参 | 语义 |
| --- | --- | --- | --- |
| `zcode_create_session` | `{workspacePath, mode}` | `{sessionId}` | 在工作空间新建会话;`mode` 直通权限模式声明 |
| `zcode_send` | `{sessionId, workspacePath, message, reasoningLevel}` | `{sessionId, accepted}` | 向既有会话发送一轮;立即返回,不等待终态 |
| `zcode_status` | `{sessionId, workspacePath, afterSeq?}` | `{sessionId, status, lastSeq, recentEvents[], pendingRequests[], lastTurn, model?, mode?}` | 读取状态与事件;`recentEvents` 为 afterSeq 之后的**单调去重窗口**(B5-3 修订:真实宿主在多会话并发下可能丢弃流式噪音事件,推送流与 `session/events` 拉取都无法保证逐 seq 连续;采纳安全性由适配器的结构不变量保证——窗口恰一个 `turn.started`、恰一个终态事件且顺序正确、终态响应与 `lastTurn` 交叉验证);`response` 不得截断标记 |

### 4.2 B1 新增:`zcode_verify_session`

| 项 | 契约 |
| --- | --- |
| 入参 | `{sessionId, workspacePath}` |
| 出参 | `{sessionId, exists: boolean, workspacePath?, status?, title?, mode?, model?, updatedAt?}` |
| 语义 | **权威会话身份,以官方 `session/resume` 为存在性判据**:resume 返回官方 "Session not found" → `exists: false`(确定性否定);resume 成功 → 会话存在且可附接到该工作空间 → `exists: true`,再以 `session/read`/`session/list` 尽力补充状态与归属佐证 |
| 否定语义 | 仅官方 not-found 信号构成确定性否定。`session/read` 的 "Session is not active" 只说明该 app-server 实例未附接,**不是否定**;`session/list` 不列出未附接会话,空列表同样**不是否定** |
| 不确定语义 | resume 其他错误(实例退出、超时、畸形)、read/list 与 resume 结果不一致 → 工具报错;适配器转 uncertain,不产出确定性结论 |

实测边界(2026-10-24,官方 CLI 记录于 B1 证据):经 app-server 子进程以 `persistence:"immediate"` 创建的**零轮次**会话,在子进程终止后 resume 返回官方 "Session not found"——即零轮次诊断会话不跨 app-server 实例存活。真实闭环锚定的桌面会话(有轮次、随桌面实例存活)不受此影响;该边界在锚定会话验证(B3+)必须复验。

适配器侧消费(`ZCodeAdapter.verifyExternalSession`):本地先校验 `sessionId` 格式;首次验证在 journal 固化 `(host_session_id, connection_subject)` 绑定,后续验证主体不一致返回确定性 `false`;连接器失败抛 `INTERNAL{uncertain:true}`。能力声明 `external.current_session_identity` 仅在真实探针证据+独立验收后翻转。

### 4.3 B3:`zcode_load_material` / `zcode_lookup_load`(已实现并真实证据)

| 工具 | 入参 | 出参 | 语义 |
| --- | --- | --- | --- |
| `zcode_load_material` | `{sessionId, workspacePath, loadKey, contentHash, filePath}` | `{sessionId, loadKey, accepted, marker}` | **intent 先行落库**(`--journal`),向原会话发送载入协议轮(读取 filePath、核对头部、精确回显标记行;reasoningLevel low),立即返回事件 marker 供轮询。官方 `session/send` 强制 `modelSelection.providerId/modelId`(B3 实测,Zod 校验)。 |
| `zcode_lookup_load` | `{sessionId, workspacePath, loadKey, contentHash}` | `{state:"loaded"\|"absent"\|"unknown", confirmation?, reason?}` | **权威载入对账**:活实例先按事件窗口验证;跨实例靠 journal 重放确认(app-server 不在 `session/events` 重放 resume 前历史——B3 实测边界)。 |

**载入确认判据(全部满足才算 loaded)**:

1. 窗口内恰一条 `turn.started`,其 `payload.input` 含 `roledock-anchor-load/<loadKey>`;
2. ≥1 个成功且未截断的 `tool.updated` 事件,其 `result.content` 同时包含 `roledock-anchor-load/<loadKey>` 与 `sha256:<contentHash>`(结构性"宿主真实读取了材料文件"证据);
3. 窗口终态为 `turn.completed` 且响应包含精确标记行 `ROLEDOCK-ANCHOR-LOADED <loadKey> <contentHash>`;
4. `load_version` = 该会话内按首次出现序的已确认 distinct load_key 序号(≥1,单次确认后经 journal 固定)。

材料文件由适配器写入(内容寻址):头两行为 `roledock-anchor-load/<loadKey>` 与 `sha256:<contentHash>`,其后为完整 bootstrap payload;`content_hash` 只覆盖 payload(核心 bundle_hash 口径)。轮失败/无工具证据/标记缺失一律 `unknown`(核心 drive 归类 uncertain),绝不产生假确认。**时序边界**:载入轮是真实模型轮次(low reasoning 约数十秒),适配器轮询 300s 期限,宿主出现待人请求即 uncertain(需要操作者而非重试);载入确认本身不证明工具范围被强制——隔离证明由 B5-2 逃逸矩阵与受管执行边界提供(§4.5)。

### 4.4 B4:`zcode_cancel` / `zcode_close`(已实现并真实证据)

| 工具 | 入参 | 出参 | 语义 |
| --- | --- | --- | --- |
| `zcode_cancel` | `{sessionId}` | `{sessionId, stop_signal_sent}` | 官方 `session/stop`:中止当前运行中的轮;host 空闲时为诚实 no-op。**绝不关闭会话**;信号未被确认时适配器转 uncertain(不知轮次状态)。 |
| `zcode_close` | `{sessionId}` | `{sessionId, closed}` | 官方 `session/close`:宿主删除其事件存储并回收会话;`closed:false` 原样上报(适配器转 uncertain)。closed:true 后该会话句柄失效,按创建键查询返回 null。 |

适配器配套(createSession 带 bootstrap):B4 起 `createSession` 接受 `bootstrap`(内容寻址材料文件 + 真实载入轮 + 四判据确认后才返回句柄,intent 先行落库),解锁 `sessions.open inherit=latest` 的跨会话继承(实测 generation 2 交接);`capability_scope`/`temp_dir` 仍 NOT_IMPLEMENTED。能力声明:`load_materials`/`reconcile_load`/`cancel` 自 B4 起为 true(B3 真实锚定证据 + 本增量取消证据);四项隔离保持 false(G01-Z03 残余:plan 模式写被权限门控且有中止实验证据,但工具范围与嵌套 Agent 约束未证明),全访问路径(独立请求)按设计拒绝。

### 4.5 B5-1:受管执行(已实现并真实证据;ADR-0012)

被隔离的咨询分支宿主进程跑在 RoleDock 启动的 OS 沙箱内(受管执行);主锚定会话不沙箱。B5-0 为本节预留参数面,B5-1 交付实现并以真实链验证(证据 `phase-reports/evidence/2026-10-24-p5-h-b5-1/`);声明翻转仍随 B5-4(逃逸证据集与全链复验前提见 `docs/ADAPTER_SANDBOX_PLAN.md`)。runner 选型定档见 `docs/toolchain.md` §沙箱 runner 定档(bubblewrap 0.6.1 + 非特权 userns)。

**`--sandbox` 连接器参数(默认关闭)**:

- 默认关闭:不传该参数 = 既有行为零变化。
- 启用即受管模式:连接器启动前探测 runner(存在性 + 版本 + 以真实 namespace 集合干跑);**不可用即 `NOT_IMPLEMENTED` 错误信封退出**(失败关闭),绝不静默忽略、绝不无沙箱降级运行而仍声明隔离。`ROLEDOCK_SANDBOX_PROBE=unavailable` 诊断覆盖只允许"更严格"方向(强制判不可用),不提供反向覆盖。

**`--sandbox-egress <host[:port]>`(可重复,默认端口 443)**:

出口白名单,配置化传入不硬编码。实现拓扑(不依赖 slirp/iptables/容器运行时):

1. 连接器为每个白名单条目分配一个伪 loopback IP(127.0.0.2 起,127/8 全走 lo),生成沙箱内 `/etc/hosts`(NSS 仅 files,其余域名无解析)。
2. 沙箱内中继进程按映射监听 `伪IP:port`,把连接经 bind-mounted Unix socket 交给宿主侧转发器;宿主转发器**再次校验目标在白名单内**后连接真实端点,双向裸管道——TLS 端到端不 MITM,app-server 侧证书校验按域名正常通过。
3. 非白名单出口结构性失败:netns 仅 lo 无路由、hosts 无条目、中继无映射;宿主转发器对白名单外的 `ROLEDOCK-EGRESS` 目标一律拒断(计数进证据)。

**受管 spawn 语义**(参考连接器 0.4.0,`adapters/zcode/src/sandbox.ts`):

| 项 | 语义 |
| --- | --- |
| 边界 | `--unshare-user/pid/net/ipc/uts`(cgroup ns try)+ `--die-with-parent --new-session`;pid namespace 边界覆盖 app-server 全部子进程(嵌套 Agent、插件 MCP、孙进程) |
| 最小权限 | 仅 `--cap-add CAP_NET_BIND_SERVICE`(沙箱自有 netns 内绑定白名单端口所需) |
| 文件系统 | **根 tmpfs 只读**（`--tmpfs /` + 全部挂载后 `--remount-ro /`，B5-2 起）：白名单区之外的一切写入 EROFS/ENOENT；ro:/usr、/etc/ssl、/etc/hosts(生成)、ld.so.cache/nsswitch/passwd/group/machine-id(try)、CLI 文件、provider 配置两文件(元数据非凭据)、node 目录、连接器 runtime 目录；rw:连接器 cwd(单工作空间根,`.roledock/` 含材料目录随行);tmpfs:/tmp 与 HOME(HOME 永不 bind 宿主真身,凭据存储不可见) |
| 环境变量 | `--clearenv` 后仅注入白名单(PATH/HOME/TMPDIR/LANG/XDG 三项/ZCODE 两配置文件路径);owner token、`ZCODE_CREDENTIAL_SECRET` 与宿主账户存储不进沙箱;模型 API 头沿用 §3 helper RPC 经 stdio 按需注入 |
| 设备 | 逐节点 `--dev-bind` 提供 null/zero/random/urandom(bwrap `--dev` tmpfs devtree 在本内核使特权端口绑定 EACCES,见 toolchain.md) |
| 进程树回收 | 连接器进程组 kill → bwrap 随亡 → pidns 销毁;真实证据:运行期 2 个沙箱进程,断开后 0(1-chain.log) |
| cgroup 限制 | **裁定（B5-2 验收 §4-1,B5-4 落档）:cgroup 资源上限不是四项隔离声明的必要条件**(pidns+userns+netns+根只读边界覆盖已实证,逃逸矩阵全拦截且经验收方独立重跑);cgroup CPU/内存/pids 上限保持可选加固项(`--unshare-cgroup-try` 在位),未强制不构成声明缺口 |

**沙箱内证据**(supervisor 写入 `<workspace>/.roledock/sandbox-evidence/`,随真实链留档):`env-keys.json`(仅键名)、`mounts.txt`(沙箱内 mountinfo 全文=边界清单)、`supervisor.log`(loopback/relay/app-server 生命周期)。受管模式为**单工作空间语义**(连接器 cwd 为唯一 rw 根);`capability_scope`/`temp_dir` 的受管解锁仍属 B5-3。

**逃逸测试证据(B5-2,2026-10-25)**:§4 逃逸矩阵 8 行全部以真实沙箱执行取证并全数拦截(41 项裁定 + 行 4 真实模型轮 + 行 8 生命周期 4 项),矩阵固化为可重跑脚本 `phase-reports/evidence/2026-10-25-p5-h-b5-2/`(escape-payload.cjs 在生产同参数边界内实测);每行裁定与"任何一项逃逸即 REWORK"的门槛见该目录三个脚本与其 JSONL 日志。

**受管请求链(B5-3,2026-10-25)**:

- **新增工具 `zcode_sandbox_status`**(连接器 0.5.0):无入参,返回 `{sandboxed, runner, egress_entries, workspace_root}`——适配器声明 full 隔离前用它**验证**连接器真的在沙箱内;非沙箱连接器如实返回 `sandboxed:false`。
- **适配器受管模式**(`new ZCodeAdapter({managed:{egress}})`):capabilities 变为 `level:"full"` + 四项隔离 true(非受管保持 restricted/false);首次受管 createSession 调用 `zcode_sandbox_status` 校验(sandboxed + runner + egress 集合相等),不符即 NOT_IMPLEMENTED 失败关闭;`capability_scope`/`temp_dir` 被接受并冻结入 journal(`request_scopes` 表,`requestScope()` 审计视图),temp_dir 由适配器宿主侧创建、位于工作空间 rw 白名单内;bootstrap 走 B4 真实载入流程。
- **材料目录只读白名单**:`.roledock/anchor-materials/` 以 ro-bind 覆盖工作空间 rw 绑定(载入轮只读;适配器宿主侧写入不受影响)。
- **并发正确性**(10 重叠请求实测暴露并修复):`start()` 单飞化(并发首调只 spawn 一个沙箱);`zcode_status` 的 `recentEvents` 窗口上限从固定 20 提到缓冲容量 500(§4.1 窗口保证相应修订);转发器 header 帧解析字节化(UTF-8 字符串往返会损坏二进制 TLS 握手——`MODEL_TLS_VALIDATION_FAILED` 根因,见 B5-3 报告 §5)。
- 证据:`phase-reports/evidence/2026-10-25-p5-h-b5-3/`(05H 步骤 7 十重叠请求全完成 + 步骤 8 显式采纳 + 预算/取消受管回归,全程 22 个真实模型轮)。

## 5. 证据要求

真实探针运行必须记录:连接器文件 sha256、连接器 `serverInfo` 版本、`tools/list` 结果、官方 CLI 入口文件 sha256、各工具调用结果摘要。Mock/fixture 通过不构成真实宿主证据。

### 4.6 G3:`zcode_list_sessions`(已实现;真机 spike 证据)

原桌面会话产品接入(P6-G3,ADR-0014 §9.1)的只读发现工具。无副作用:不创建、不 resume、不附着任何会话,零模型轮。

- **工具名** `zcode_list_sessions`,入参 `{workspacePath}`(绝对路径);返回 `{sessions:[{sessionId,title,status,sessionKind,updatedAt,workspace}]}`。
- **语义**:app-server `session/list` 为工作空间存储级枚举——2026-10-27 真机 spike 实证:全新 app-server 实例零附着即返回该工作空间全部持久化会话(含用户正在使用的桌面会话);旧注释"list 不显示未附着会话"对当前 CLI 版本不成立。`sess_*`(实例内存)与 `session_*`(持久化桌面)条目并存,结构上可辨。
- **消费者**:仅服务端 adapter `listHostSessions`(`externalSessions.discover` trusted 面)与桌面受信桥;不开放给普通 Agent 会话。
- **证据**:`phase-reports/evidence/2026-10-27-p6-g3/spike-discovery/`(spike-list.mjs / spike-resume.mjs / spike-listonly.mjs 与 FINDINGS.md)。
