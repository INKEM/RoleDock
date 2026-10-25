# P5-H-b5-3 开发报告:请求链受管接入(05H 步骤 7–8 首次真实跑通)

日期:2026-10-25;状态:**待独立验收**。

按 [ADR-0012](../adr/0012-adapter-enforced-isolation.md) 与 [ADAPTER_SANDBOX_PLAN](../ADAPTER_SANDBOX_PLAN.md) §3 执行 P5-H 增量 B5 系列第四增量 B5-3。前置:B5-0～B5-2 独立验收尚待进行(所有者指示连续续作)。本增量交付:核心 requests executor 经**受管适配器变体**接线(核心门禁语义零改动)、`capability_scope`/`temp_dir` 在受管路径生效、材料目录只读白名单,并完成 **05H 验收链步骤 7(10 个重叠请求在沙箱实例真实完成,零主会话注入)与步骤 8(收件箱显式采纳)** 的真实证据,预算/取消路径受管回归通过。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(同一工作区;`evidence/2026-10-25-p5-h-b5-3/baseline-head.txt`)。
- 组件哈希 `host-components.sha256`(CLI 入口、helper、连接器 0.5.0、sandbox.js、index.js、链脚本);无新 npm 依赖。

## 2. 交付与退出条件对应

| 退出条件(ADAPTER_SANDBOX_PLAN §3 B5-3) | 交付与证据(`evidence/2026-10-25-p5-h-b5-3/`) |
| --- | --- |
| 咨询分支经受管 createSession(`temp_dir`/`capability_scope` 生效) | 受管构造 `managed:{egress}`:capabilities `level:"full"`+四项隔离 true;首次受管 createSession 经新工具 `zcode_sandbox_status` 验证(sandboxed+runner+egress 集合相等),不符即 NOT_IMPLEMENTED;scope/temp_dir 冻结入 journal `request_scopes` 表(`requestScope()` 审计视图),temp_dir 位于工作空间 rw 白名单内并由适配器宿主侧创建;非受管构造仍拒绝二者(既有测试保持)。1-request-chain.log + adapter-journal-dump.json(10 条冻结 scope/temp_dir) |
| 材料目录只读白名单 | `.roledock/anchor-materials/` ro-bind 覆盖工作空间 rw 绑定(载入轮只读;适配器宿主侧写入不受影响;连接器受管启动时预建目录保证绑定生效) |
| 05H 步骤 7:10 重叠请求真实完成、零注入 | **10/10 completed(84s 墙钟,并发池 3 重叠批次)**,每请求 = 沙箱内受管 createSession(真实材料载入轮)+工作轮;10 个 `kind='request'` 会话 `instance_id=NULL`、host session 互不相同;10 artifact + 10 inbox;两个主会话 active 且 host 引用与请求会话无交集(零注入);全程 22 个真实模型轮(2 锚定载入 + 10×[载入+工作])。1-request-chain.log |
| 05H 步骤 8:收件箱采纳 | `artifacts.read`(正文匹配 REQUEST-OK-0)→ 经 builder 主会话连接 `documents.publish{adopt_artifact_id}` **显式采纳** → candidate `source:"request.result", state:"adopted"`(revision 1) |
| 预算/取消路径受管回归 | 预算:deadline 在执行前失效 → 请求 failed、**零宿主会话创建**;取消:queued 请求 cancelRequest → cancelled、从未创建宿主会话(createRequest 对过去 deadline 的拒绝也在位) |
| 既有请求语义测试全绿 | `npm run check` 439/439(新增受管 fixture 6 项,含 10 请求经 executor 门禁全链 fixture 级验证);既有请求语义/状态机测试无改动全过 |

## 3. 声明语义(与 B5-4 的关系)

受管变体的 full/true 声明**与事实绑定**:每次构造后首次受管 createSession 都必须通过 `zcode_sandbox_status` 验证(连接器 0.5.0 新工具;非沙箱连接器如实返回 `sandboxed:false`),不符即 NOT_IMPLEMENTED——绝不无沙箱执行而声明隔离。非受管 zcode 适配器保持 restricted/false。B5-4 仍负责:05H 八步全链复验、受管变体进入 conformance 套件、正式翻转收口。

## 4. 主要文件与公共接口变化

- `adapters/zcode/src/reference-connector.ts`(0.4.0→**0.5.0**,工具集变更):新增 `zcode_sandbox_status`;`start()` 单飞化(并发首调只 spawn 一个沙箱——10 重叠请求暴露的竞态);`zcode_status` 的 `recentEvents` 窗口上限 20→500(§4.1 连续窗口契约在长流式轮下被固定 20 截断破坏);受管启动预建 anchor-materials 目录。
- `adapters/zcode/src/sandbox.ts`:材料目录 ro-bind-try;转发器 header 帧解析**字节化**(关键修复,见 §5);转发器逐连接 trace 日志(`<socket>.log`:目标、首 16 字节、字节数——兼作逃逸证据)。
- `adapters/zcode/src/index.ts`:受管构造选项、capabilities 分支、`#verifyManaged`、`request_scopes` journal 表与 `requestScope()` 审计方法;`getResult` 采纳不变量修订(§5)。
- `adapters/zcode/test/zcode-adapter.test.ts`:受管 describe 6 项(能力声明/验证一次缓存/非沙箱拒绝/egress 不匹配拒绝/缺工具拒绝/10 请求经 executor 门禁全链)。
- 文档:`docs/zcode-connector-tools.md` §4.1(窗口保证如实修订)+ §4.5(受管请求链);`docs/spec/adapter-contract.md` B5 节(第 5/6 条);`docs/zcode-integration.md` 状态行。核心包零改动。

## 5. 失败、边界与开发修复(全部有实证)

1. **`MODEL_TLS_VALIDATION_FAILED` 根因(本增量最重要修复)**:同一沙箱内第二次模型流必然失败(位置性、确定性)。逐层实验(无沙箱两轮对照 → 中继 keep-alive/连续连接复现 → 转发器字节取证)定位:转发器以 `String(chunk)`(UTF-8)处理二进制 TLS 流,当中继头行与 ClientHello 同段到达时,头后随机 TLS 字节经 UTF-8 往返损坏 → provider 回 decode_error alert。修复为纯字节帧解析后,免模型实验 4/4 连接全过、真实链二连载入即恢复。修复前 5 次链尝试的失败日志未留档(诊断期覆盖),根因证据见修复后 `egress.sock.log`(B5-2 矩阵脚本同链路回归亦通过)。
2. **真实宿主并发下推送流丢事件**:10 会话并发时单条 `model.streaming` 事件从推送流与 `session/events` 拉取同时缺失(证据:卡住轮次 events_json 的 seq 50 缺口),固定 20 条窗口截断使严格连续性校验永久失败。修复:窗口上限 500 + 采纳不变量改为结构校验(窗口起点在我们自己的 send 标记之后、恰一个 turn.started、恰一个终态、严格递增、终态响应与 lastTurn 交叉验证)——旧答案采纳的防护不变,噪音事件缺口不再阻断。§4.1 契约措辞如实修订。
3. **createRequest 拒绝过去 deadline**:原脚本用过去 deadline 触发预算回归被创建时校验拒绝——改为短 deadline 失效后执行,零支出结论不变。
4. **诚实边界**:受管变体的 full 声明限于 `managed` 构造并经逐会话验证;provider 侧偶发流挂起(本轮 1/22 轮)按既有语义如实 uncertain——取消后的会话不可再花轮次属契约语义,无自动重放。
5. **conformance 决策(本增量内决定并记录)**:受管变体进入 `defineAdapterContractSuite` 属 B5-4 退出条件(计划表);B5-3 的 executor 门禁接线已完成 fixture 级验证,套件工厂对 `make()` 的全能力要求由 B5-4 以受管变体满足。

## 6. 测试门禁

zcode 包 50/50(新增 6 项);全量 `npm run check`:41 文件 / 439 测试全部通过(`evidence/2026-10-25-p5-h-b5-3/full-check.log`)。

## 7. 下一增量可用输入与未满足退出条件

- **B5-4(声明翻转与收口)输入**:步骤 7–8 真实证据已在本增量;B5-4 需 05H 八步全链复验(步骤 1–6 生产回归 + 7–8 受管)、受管变体进入 conformance 套件、隔离声明翻转的正式收口材料。
- **未满足的收口条件**:四项隔离声明的正式翻转、G01-Z03 关闭、P5-H BLOCKED 解除均属 B5-4 + 独立验收;本增量的声明限于受管变体且与沙箱验证绑定。
