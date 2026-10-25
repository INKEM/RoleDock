# P5-H 增量 B5-3 独立验收：请求链受管接入（05H 步骤 7–8 首次真实跑通）

日期：2026-10-25
验收方：独立验收 Agent；未修改产品实现、未发送新模型任务（复用开发方链证据；逃逸矩阵重跑零模型成本）
结论：**PASS**（B5-2 验收的两项跟进项未完成、随本报告转为 **B5-4 必办前置**，见 §4）

## 1. 范围与基线

验收对象为 ADAPTER_SANDBOX_PLAN §3 第四增量 B5-3，开发报告 `P5-H-b5-3-development.md`。基线沿用同一工作区。mtime 核验：门禁证据（16:04）后仅两份交付文档（`adapter-contract.md`、`zcode-integration.md`）与构建产物更新——文档为本增量交付物、不影响测试有效性，内容已实读核对与报告一致。

## 2. 逐项核验（计划 §3 B5-3 退出条件）

| 退出条件 | 实际行为与证据 | 判定 |
| --- | --- | --- |
| 咨询分支经受管 createSession（scope/temp_dir 生效） | 受管构造 `managed:{egress}` → `level:"full"` + 四项隔离 true（非受管保持 restricted/false，实读 index.ts:63-64）；首次受管 createSession 经 `zcode_sandbox_status` 验证（sandboxed + bubblewrap + egress 集合严格相等），不符即 NOT_IMPLEMENTED（`#verifyManaged`，实读 73-85）；scope/temp_dir 冻结入 journal `request_scopes` 表（`requestScope()` 审计），temp_dir 位于工作空间 rw 白名单内、适配器宿主侧创建；非受管构造仍拒绝二者（fixture 断言）。`adapter-journal-dump.json`：10 条冻结 scope。 | 满足 |
| 材料目录只读白名单 | `.roledock/anchor-materials/` ro-bind-try 覆盖工作空间 rw 绑定（sandbox.ts:153）+ 连接器受管启动预建目录保证绑定生效（reference-connector.ts:133-136）；载入轮只读、适配器宿主侧写入不受影响。 | 满足 |
| 05H 步骤 7：10 重叠请求真实完成、零注入 | `1-request-chain.log`：10/10 completed（84s 墙钟，有界并发池）；10 个 `kind='request'` 会话 `instance_id=NULL`、host session 互不相同；10 artifact + 10 inbox；两个主会话 active 且 host 引用与请求会话无交集（零注入）；全程 22 个真实模型轮。fixture 级同构测试（10 请求经 executor 门禁全链）断言 artifacts/inbox/会话数/scope 审计/`zcode_sandbox_status` 恰调用一次（验证一次缓存）。 | 满足 |
| 05H 步骤 8：收件箱采纳 | `artifacts.read` 正文匹配 `REQUEST-OK-0` → builder 主会话连接 `documents.publish{adopt_artifact_id}` 显式采纳 → candidate `source:"request.result", state:"adopted"`（revision 1）。 | 满足 |
| 预算/取消受管回归 | 过期 deadline 请求执行前 failed、零宿主会话创建；queued 请求 cancel → cancelled、从未创建宿主会话。 | 满足 |
| 既有请求语义测试全绿 | 独立门禁 **41 文件 / 439 测试全部通过，exit 0**（与开发方 `full-check.log` 一致；含受管 describe 6 项）。 | 满足 |

## 3. 关键修复与边界核验

1. **TLS 字节帧修复（本增量最重要）**：`EgressForwarder` header 帧解析已字节化（Buffer-only，实读 sandbox.ts:262-285，注释记录根因——UTF-8 字符串往返损坏二进制 TLS 握手）；逐连接 trace 日志（目标/首 16 字节/字节数）兼作逃逸证据。**回归验证**：本验收方重跑 B5-2 逃逸矩阵——**41 项裁定全拦截、exit ok**，B5-3 的转发器/窗口改动无回归。
2. **并发正确性**：`start()` 单飞化（并发首调只 spawn 一个沙箱）；单沙箱多会话架构下 `sandboxed-processes-during: 2` 计数正确（链脚本 177 行在执行后测量，单飞后恒为 1 沙箱）。`zcode_status` 窗口 20→500 + 采纳不变量结构化（窗口起点在自有 send 标记之后、恰一个 turn.started、恰一个终态、严格递增、终态与 lastTurn 交叉验证——实读 index.ts:309-320），旧答案采纳防护不变；§4.1 契约措辞如实修订（真实宿主并发下流式噪音事件可能丢失）。
3. **声明语义**：受管变体的 full/true 与运行时事实绑定（逐实例验证 + 失败关闭）；非受管路径与既有 439 项测试中的声明语义无变化。受管变体进入 conformance 套件属 B5-4（计划表定位），B5-3 内的决策（工厂 `make()` 全能力要求由受管变体满足）已记录。
4. **诚实披露**：provider 侧偶发流挂起（1/22 轮）按既有语义如实 uncertain；5 次修复前链尝试日志未留档（诊断期覆盖）已在报告中如实声明，根因证据以修复后转发器 trace + 免模型实验替代。

## 4. 未完成项与裁定（原 B5-2 验收跟进项）

1. **N1（cgroup 裁定落档）与 N2（行 5 断言修复 + 矩阵重跑）未完成**：toolchain.md 与 §4.5 的 cgroup 行仍写"留 B5-2 裁定"；矩阵脚本行 5 解析正则未修（本验收方重跑仍显示 "(missing)"，底层 JSON 证据真实一致）。**裁定：不构成 B5-3 返工**——开发方报告如实声明其开工时 B5-0～B5-2 验收尚待进行（"连续续作"流程的一拍滞后），无法见到该要求；两项均为文档/守卫脚本修改，不动实现。**但两项随本报告转为 B5-4 必办前置**：(a) B5-4 开工即完成 toolchain.md cgroup 行与 §4.5 cgroup 行的裁定落档（结论：cgroup 资源上限不是四项隔离声明的必要条件，pidns+userns+netns+根只读边界覆盖已实证；上限保持可选加固项）；(b) 修正矩阵脚本行 5 正则以匹配实际 ns 格式、解析失败显式裁定 false，重跑矩阵确认 41 项全过且行 5 detail 不再是 "(missing)"。**B5-4 的独立验收将把这两项作为硬性检查项；隔离声明翻转的正式收口在其完成前不予接受。**
2. **观察（P4，记录不阻塞）**：受管适配器构造时即声明四项隔离 true，运行时验证在首个带 scope/temp_dir 的受管 createSession 触发；主锚定路径（无 scope 入参）不触发该验证——缓解为连接器级失败关闭（`--sandbox` 启用即必须沙箱）+ 请求路径（隔离相关路径）恒触发验证。如 B5-4 需要更强保证，可把验证提前到受管构造时。

## 5. 结论与后续

**PASS**。05H 验收链步骤 7（10 重叠独立请求，沙箱实例真实完成、零主会话注入）与步骤 8（收件箱显式采纳）首次具备真实宿主证据；受管变体声明与沙箱事实绑定、失败关闭。四项隔离声明的正式翻转、G01-Z03 关闭、P5-H 收口属 **B5-4**：需完成 §4-1 两项前置 + 05H 八步全链复验（步骤 1–6 生产回归 + 7–8 受管）+ 受管变体进入 conformance 套件，并经独立验收。
