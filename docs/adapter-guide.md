# 适配器指南（Harness Adapter Guide）

协议版本：0.1 · 状态：P5 已固化（待独立验收）

本指南说明如何把一个宿主（Harness）接入 RoleDock：适配器端口的契约、能力与降级规则、三层验证模型、进程桥接的消息协议，以及"已有会话接入"的正确方式。权威契约见 `docs/spec/adapter-contract.md`；端口类型在 `@roledock/core` 的 `ports/adapter.ts`。

## 1. 适配器端口

核心只通过 `HarnessAdapter` 与宿主交互，从不直接调用模型 API，也从不自行构造宿主——适配器经 `Coordinator.open({ root, adapter })` 注入。

**必选方法**（缺失即不构成适配器）：

| 方法 | 语义 |
| --- | --- |
| `getCapabilities()` | 能力清单、隔离声明与受限等级 |
| `createSession(input)` | 新建宿主会话；`input.creation_key` 用于幂等创建与崩溃后对账；`bootstrap` 载入前必须做内容哈希校验 |
| `runTurn(handle, turn)` | 执行一轮；`turn.message` 是调用者可见内容 |
| `getResult(handle)` | 报告 `{ state, turn_count, execution_key?, completed?, body?, output_bytes?, needs_input? }`，running 不可当完成 |
| `closeSession(handle)` | 关闭并回收 |

**协商能力**（`getCapabilities().optional` 声明后才可被核心调用；未声明即不被调用）：

| 能力 | 语义 |
| --- | --- |
| `cancel` | 取消进行中的执行 |
| `lookup_session_by_creation_key` | 按创建键查宿主会话（崩溃/不确定创建后的对账依据） |
| `native_resume` | 宿主原生恢复会话上下文 |
| `native_fork` | 宿主原生复制会话上下文 |

核心对未声明的可选方法绝不调用；适配器对不支持的操作应如实失败或降级，不得伪装成功。

## 2. 能力等级与降级

- **full**：上下文、临时写入、结果、能力作用域四项隔离全部可保证。
- **restricted**：任一隔离缺失。需要隔离的任务被核心显式拒绝（`ADAPTER_CAPABILITY_MISSING`）；受限宿主**不得**标注为完整接入。

如实降级的例子（两种参考实现都有）：进程桥接不支持 `nativeResume/nativeFork`（声明为 false），`sessions.resume` 据此返回 `resumed:false` 并指向语义继承路径，而不是假装恢复成功。

## 3. 三层验证模型

| 层 | 对象 | 有效性 |
| --- | --- | --- |
| Mock（`@roledock/adapter-mock`） | 状态机、故障注入、并发 | 验证核心状态行为；**不是**真实宿主证据 |
| 进程桥接（`@roledock/adapter-process-bridge`） | 真实子进程、OS 执行、消息边界、断线 | 验证桥接与边界；fixture 宿主是固定回答程序 |
| 真实 Harness（`harness-reference/`，未交付） | 角色载入、上下文隔离、端到端 | 唯一可证明"真实接入"的层 |

Mock 与进程桥接通过**同一契约测试套件**（`tests/conformance/adapter-suite.ts`）；适配器专属机制（故障注入、真实进程）在各自包内测试。夹具的通过记录不得写成真实宿主证据；真实 Harness 测试单独标记，跳过不算通过。

## 4. 实现一个适配器

1. `implements HarnessAdapter`，返回完整 `AdapterCapabilities`（名称、等级、四项隔离、四项可选能力）。
2. `createSession` 按创建键幂等：同键返回原会话；载入 `bootstrap` 前重算 SHA-256 并与 `content_hash` 比对，不符即 `VALIDATION_FAILED`（宿主侧拒绝，不得由桥接方代签）。
3. 创建结果不明（崩溃窗口）时：要么支持 `lookup_session_by_creation_key` 供对账，要么把失败暴露为带 `details.uncertain: true` 的错误——核心会记录 `execution_uncertain` 并按创建键恢复，绝不盲目重复有副作用的创建。
4. 外部状态落盘/落库到创建键可寻址的位置，使崩溃后可对账；数据库是核心侧权威，宿主侧状态以宿主为准。
5. 将 bootstrap 的角色指令与授权知识正文真正载入；请求传入的 capability_scope/temp_dir 必须隔离。按 execution_key 去重轮次并在 getResult 返回对应键及实际正文；close 幂等，cancel 阻止之后的新轮次。
6. 把实现加入 `tests/conformance/adapter-suite.ts` 的实例化列表（第三个 `contract.test.ts`），保持契约行为一致。

参考实现：`adapters/mock/src/index.ts`（内存）、`adapters/process-bridge/src/index.ts`（真实进程）。

## 5. 进程桥接协议（参考）

桥接的每次操作 spawn 一个短命宿主进程：**argv 数组传参、材料经 stdin/文件传递，绝不拼接 shell 字符串**。

- 进程：`node host/fixture-host.mjs <load|turn|result|close|lookup> --session-dir <dir> [--creation-key K] [--chaos <mode>]`
- 请求（`turn`）经 stdin 传一行 JSON `{"message": ..., "execution_key": ..., "budget": ...}`；应答为 stdout 一行 JSON `{"ok":true,...}`；失败为非零退出 + stderr 一行 `{"ok":false,"error":{"code","message"}}`（桥接透传宿主协议错误码）。
- 会话目录即宿主状态：`session.json`（注册表）、`bootstrap.json`、`transcript.jsonl`、`result.json`、`tmp/`（close 时回收）。
- `--chaos uncertain-create`：写注册表后崩溃（宿主可能已创建→对账路径）；`--chaos crash-turn`：轮次落盘后 ack 丢失（断线→持久状态即真相）。

桥接声明 `nativeResume/nativeFork=false`：跨进程延续走通用分支路径（新建宿主会话 + BootstrapBundle），这是 ADR-0002 的设计，不是缺陷。

## 6. 已有会话接入（宿主启动钩子/wrapper）与 MCP 的边界

把 RoleDock 角色接入一个"已有"宿主会话，必须由**宿主启动钩子或 wrapper 在首个工作轮次之前**完成两件事：

1. 指定本次会话代表的角色（受信绑定由协调器会话流程签发，不是客户端自报）；
2. 载入 BootstrapBundle（或首代初始化材料），确认后才进入第一个工作轮次。

**仅把 RoleDock MCP 工具接到宿主不构成会话接管**：工具连接不改变宿主的会话创建路径，无法保证角色材料在首个工作轮次前载入。这一点写入适配器文档以避免错误预期；P6 的 MCP 入口提供的是工具/资源面，会话生命周期仍走 `sessions.open` 与适配器。

## 7. 真实宿主接入清单（harness-reference 前置）

- 宿主名称与版本，官方 CLI/SDK 及其无头/非交互调用方式（官方资料核查，不猜参数）；
- 用户授权范围（凭据、配额、可执行任务类别）；
- 角色载入证据：BootstrapBundle 在首个工作轮次前被宿主消费；
- 上下文隔离证据：请求分支不共享主会话历史；
- 执行日志：适配器/宿主/模型版本与结果引用，去除敏感凭据。

## 8. P5-H ZCode当前状态

用户已指定ZCode，`adapters/zcode`为可运行的受限诊断适配器；裸会话可获得真实模型答案，bootstrap/scope/temp_dir及外部锚定能力不足时明确拒绝，不计角色接入成功。详见[ZCode说明](zcode-integration.md)及[ADR-0010](adr/0010-zcode-restricted-integration.md)。原第6节为P5历史说明；P5-A的已有会话锚定权威契约现为[external-session-anchor](spec/external-session-anchor.md)，不要求用户聊天之前自动接管，不将MCP安装视作材料载入确认。
