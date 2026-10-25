# P5-H-b5-4 开发报告:声明翻转与收口(05H 八步全链复验 + conformance 接入 + 验收前置完成)

日期:2026-10-25;状态:**待独立验收**。

按 [ADR-0012](../adr/0012-adapter-enforced-isolation.md) 与 [ADAPTER_SANDBOX_PLAN](../ADAPTER_SANDBOX_PLAN.md) §3 执行 P5-H 增量 B5 系列收口增量 B5-4。前置:B5-0…B5-3 已独立验收 PASS(`P5-H-b5-0…b5-3-review.md`);本报告按 B5-3 验收 §4 的明令,**开工即先完成两项必办前置(N1/N2)**,再交付本体(声明翻转、05H 八步全链复验、受管变体进入 conformance 套件、收口材料)。G01-Z03 关闭与 P5-H 解除 BLOCKED 的**裁定**属独立验收——本报告备齐其材料。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(同一工作区;`evidence/2026-10-25-p5-h-b5-4/baseline-head.txt`)。
- 组件哈希 `host-components.sha256`(CLI 入口、helper、连接器 0.5.0、sandbox.js、index.js、八步链脚本、矩阵脚本、契约套件测试);无新 npm 依赖。

## 2. 验收前置完成证据(硬性检查项)

| 前置 | 来源 | 完成证据 |
| --- | --- | --- |
| **N1** cgroup 裁定落档 | B5-2 review §4-1 裁定(cgroup 资源上限**不是**四项隔离声明的必要条件;pidns+userns+netns+根只读边界覆盖已实证;上限保持可选加固项),B5-3 未执行转来 | `docs/toolchain.md` 沙箱定档表 cgroup 行与 `docs/zcode-connector-tools.md` §4.5 cgroup 行均已替换为裁定结论原文(标注"裁定(B5-2 验收 §4-1,B5-4 落档)")。验收方式:读两处文档。 |
| **N2** 矩阵行 5 正则修复 + 重跑 | B5-2 review §4-2(`identityOf` 正则 `kind=\[…\]` 与实际 `pid=pid:[…]` 格式不匹配,曾空真通过;解析失败需显式 false) | `b5-2-escape-matrix.mjs` 修复:正则改配 `kind=\w+:\[[^\]]+\]`,解析失败返回 null 并显式裁定 false(detail 标 "(unparsable — verdict false)")。重跑:**41 项裁定全过、exit 0**,行 5 detail 为真实 namespace 身份(`pid=pid:[4026533448],net=net:[4026533525],user=user:[4026533257]` 三层一致),无 "(missing)"。日志 `evidence/2026-10-25-p5-h-b5-4/1-escape-matrix-rerun.log`。 |

## 3. 本体交付与退出条件对应

| 退出条件(ADAPTER_SANDBOX_PLAN §3 B5-4) | 交付与证据(`evidence/2026-10-25-p5-h-b5-4/`) |
| --- | --- |
| `isolation` 四项翻转 true(随受管执行声明) | 受管变体声明与事实绑定(B5-3 建立,本增量正式收口):`managed:{egress}` 构造 = `level:"full"` + 四项 true,每次构造后首次受管 createSession 经 `zcode_sandbox_status` 验证(沙箱+runner+egress 集合相等),不符即 NOT_IMPLEMENTED;非受管保持 restricted/false。文档翻转对照见 §5。 |
| 05H 全链八步复验 | `2-full-chain.log`(一条受管沙箱连接器、全部真实模型轮):步骤 1–3 真人事件 + builder 锚定 gen1(真实载入轮)→ **预算支出前拒绝(host seq 30→30 零变化)** → 步骤 4 propose/publish(revision 1)→ 步骤 5 跨会话继承 gen2(第二次真实载入轮,首次尝试即成)→ 步骤 6 旧授权撤销(旧 binding `state:"revoked"`、旧主会话 revoked、gen2 与 reviewer 保持 active)→ 步骤 7 **10 重叠请求全部 completed(84s)**,10 会话 `instance_id=NULL`、host 互不相同、10 artifact/inbox、**零主会话注入** → 步骤 8 `artifacts.read`(CHAIN-OK-7)→ 经 gen2 主会话显式采纳(`source:"request.result", state:"adopted"`,revision 2)。进程树回收 2→0。适配器 journal:`13 次载入全 confirmed、10 轮 completed、10 会话 closed`(`adapter-journal-dump.json`)。 |
| zcode 以受管变体进入 conformance 套件 | `adapters/zcode/test/contract.test.ts`:`defineAdapterContractSuite` 工厂(make=受管+受控 fixture;makeRestricted=非受管,restricted 满足套件语义),**10 用例全过**。接入前对齐两处真实语义差异(§4);套件通过是协议一致性证据,不替代真实宿主证据(套件自身定位)。 |
| 独立验收通过 / G01-Z03 关闭 / P5-H BLOCKED 解除 | 属独立验收裁定;收口材料 = 本报告 + 四份 B5 development/review 对 + 全部 evidence 目录 + §5 文档翻转对照。 |

## 4. 契约套件接入的语义对齐(不削弱安全)

套件用例揭示三处 zcode 与共享契约的真实差异,全部对齐:

1. **背靠背双轮**(套件 "runs turns…"):宿主一次一轮。`runTurn` 对 accepted 未终态前轮**等待终态再发**(轮询限时 min(deadline,120s));`intent`(发送确认丢失)仍如实拒绝、绝不自动重放。
2. **close 后语义**(套件 "closes sessions…"):closed 句柄 `getResult` 返回 `state:"closed"`(不调宿主);closed 后 `runTurn`/`cancel` 抛 `INVALID_STATE_TRANSITION`(原 NOT_FOUND);"journal 无此 handle" 的 NOT_FOUND 保留。`closeSession` 幂等(重复 close 诚实 no-op,spec §7)。
3. **cancel 阻止后续轮次**(套件 "cancel prevents further spending…";spec §7 明文):zcode 的 cancel 原先只发官方 stop 信号——现补 journal 标记(`cancelled_sessions` 表),取消后该会话拒绝一切新轮次(在途轮仍可迟到返回,由核心终态守卫拒收)。
4. 附带:`execution_key` 缺省时自动生成(核心恒显式传入;显式键的 keyed 幂等不变)——对齐核心 TurnInput 类型中该字段可选的事实。

回归:zcode 包 **60/60**(33 adapter + 10 contract + 14 sandbox + 3 process);B4 既有断言更新一处(closed 语义 NOT_FOUND→INVALID_STATE_TRANSITION,并补 closed getResult 断言)。

## 5. 文档翻转对照

| 文件 | 翻转前 | 翻转后 |
| --- | --- | --- |
| `docs/spec/adapter-contract.md`(B5 节规则 4) | "证据经独立验收前保持 false;B5-3 后以受管变体进入套件" | 翻转已落地:受管 full/true 与验证绑定、非受管 restricted/false、已进套件 |
| `docs/zcode-integration.md`(状态段/可运行范围/行为表) | "四项隔离仍 false…G01 整体仍 BLOCKED";"所有四项隔离声明为false";行为表 5 行 | 受管/非受管双构造表述;行为表按受管/非受管分别标注(独立请求受管=门禁放行沙箱执行、非受管=拒绝;bootstrap/scope/temp_dir/cancel/close 现状) |
| `docs/zcode-connector-tools.md`(§4.3 时序边界注 + §4.4 末段) | "隔离证明属 G01-Z03";"四项隔离保持 false…capability_scope/temp_dir 仍 NOT_IMPLEMENTED" | 隔离证明指向 B5-2 逃逸矩阵;§4.4 末段翻转表述 + 过时的 NOT_IMPLEMENTED 表述更新 |
| `docs/toolchain.md` + §4.5 | cgroup "留 B5-2 裁定/best-effort" | **N1 裁定落档** |
| `AGENTS.md` 方向段 | "B5-0→B5-4 续作收口…声明翻转前证据必须独立验收" | "B5-0…B5-3 已 PASS、B5-4 交付待独立验收;声明已随受管执行翻转;Z03 关闭待验收裁定" |

不动:ADAPTER_SANDBOX_PLAN/DESKTOP_GUI_PLAN/prompts/README 计划行(验收后由验收状态驱动);ADR-0012 历史表述。

## 6. 失败、边界与未验证项

1. **开发中修复**:八步链首跑发现两处脚本瑕疵——预算回归段只写注释未搬实现(补上,重跑含 `seq 30→30` 零支出证据);`primary_sessions_untouched` 断言把步骤 6 撤销后 gen1 主会话 `revoked` 的**预期状态**误判为注入违规(改为显式的零重叠断言 + 状态打印,`revoked/active/active` 正是步骤 6 证据)。
2. **诚实边界**:受管声明的翻转严格限于 `managed` 构造;非受管路径的行为与声明零变化(既有 439 项中的非受管断言全部原样通过)。八步链在测试连接器上运行(无桌面 app;B3/B4/G-min 同形态)——产品形态中主锚定会话在桌面 app 独立连接,不受沙箱影响,这一点已写入链脚本头注。
3. **未验证项(不阻塞收口,如实列出)**:cgroup 加固(可选项,未强制);Windows/macOS(设计不支持);宿主级内核逃逸(ADR-0009/0012 威胁边界外)。

## 7. 测试门禁与收口材料索引

- zcode 包 60/60;全量 `npm run check`:41 文件 / **449 测试**全部通过(`evidence/2026-10-25-p5-h-b5-4/full-check.log`;较 B5-3 的 439 增加 10 项契约套件用例)。
- 收口材料:`evidence/2026-10-25-p5-h-b5-4/`(baseline-head、1-escape-matrix-rerun.log、2-full-chain.log、adapter-journal-dump.json、host-components.sha256、sandbox-evidence/)+ B5 系列 4 对 development/review 报告 + §5 翻转文档。
- **待独立验收裁定**:B5-4 本体、G01-Z03 关闭、P5-H 解除 BLOCKED。验收通过后,B5 系列收官,`docs/ADAPTER_SANDBOX_PLAN.md` 的目标(受管请求链在真实 ZCode 宿主完整跑通、四项隔离以逃逸证据翻转、G01-Z03 关闭、P5-H 收口)即全部达成。
