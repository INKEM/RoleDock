# P5-H 增量 B5-4 独立验收：声明翻转与收口（05H 八步全链复验 + conformance 接入）

日期：2026-10-25
验收方：独立验收 Agent；未修改产品实现、未发送新模型任务（复用开发方八步链证据；逃逸矩阵本验收期内已两度独立重跑）
结论：**PASS**。随本报告作出裁定：**G01-Z03 关闭，P5-H 解除 BLOCKED，P5 整体通过**。

## 1. 范围与基线

验收对象为 ADAPTER_SANDBOX_PLAN §3 收口增量 B5-4，开发报告 `P5-H-b5-4-development.md`。基线沿用同一工作区（B0–B5-3 已验收）。mtime 核验：自 B5-4 门禁证据（2026-10-25 17:23）后无任何源码/文档改动，本报告即验收最终树。

## 2. 验收前置（B5-3 review §4-1 明令的两项硬性检查项）——均已正确完成

| 前置 | 核验结果 | 判定 |
| --- | --- | --- |
| N1 cgroup 裁定落档 | `docs/toolchain.md` 沙箱定档表 cgroup 行与 `docs/zcode-connector-tools.md` §4.5 cgroup 行均已替换为裁定结论原文，标注"裁定（B5-2 验收 §4-1，B5-4 落档）"：cgroup 资源上限不是四项隔离声明的必要条件；边界覆盖已实证；上限保持可选加固项（`--unshare-cgroup-try` 在位），未强制不构成声明缺口。 | 完成 |
| N2 行 5 断言修复 + 重跑 | `b5-2-escape-matrix.mjs` 正则改配实际格式 `kind=\w+:\[[^\]]+\]`，解析失败显式裁定 false（代码注释记录了空真通过缺陷的来由）；重跑日志 `1-escape-matrix-rerun.log`：**41 项裁定全过、exit 0**，行 5 detail 为真实 namespace 身份（三层 `pid=pid:[4026533448]…` 完全一致），无 "(missing)"。 | 完成 |

## 3. 本体逐项核验

| 退出条件（计划 §3 B5-4） | 实际行为与证据 | 判定 |
| --- | --- | --- |
| 四项隔离翻转 true（随受管执行声明） | 翻转严格限于 `managed` 构造且与运行时事实绑定（`zcode_sandbox_status` 逐实例验证、不符即 NOT_IMPLEMENTED，B5-3 已核）；非受管保持 restricted/false（既有断言全原样通过）。文档翻转对照五处实读核对（adapter-contract 规则 4、zcode-integration 双构造行为表、connector-tools §4.3/§4.4、AGENTS.md 方向段）。 | 满足 |
| 05H 全链八步复验 | `2-full-chain.log`：真人事件 → builder 锚定 gen1（真实载入轮）→ **支出前预算拒绝（宿主 seq 30→30 零变化）** → propose/publish revision 1 → 跨会话继承 gen2（第二次真实载入轮）→ 旧授权撤销（旧 binding `revoked`、gen1 主会话 revoked 属步骤 6 预期、gen2 与 reviewer active）→ **步骤 7：10 重叠请求全部 completed（84s）、10 会话 `instance_id=NULL`、host 互不相同、10 artifact/inbox、零主会话注入** → 步骤 8：artifact 读取（CHAIN-OK-7）→ 经 gen2 主会话显式采纳（revision 2）。进程树回收 2→0；journal 三层一致（13 载入 confirmed = 2 锚定 + 10 请求 bootstrap + 1 继承；10 轮 completed；10 会话 closed）。链脚本断言实读：零注入为主/请求会话宿主引用零重叠的显式检查，非打印性断言。 | 满足 |
| zcode 以受管变体进入 conformance 套件 | `adapters/zcode/test/contract.test.ts` 实读：引用**共享套件** `defineAdapterContractSuite`（make=受管 fixture、makeRestricted=非受管——该双变体接口为套件既有参数，mock/process-bridge 早已传入，共享套件未被改动）；10 用例全过；文件头注明确"套件=协议一致性证据，非真实宿主证据"。 | 满足 |
| 收口材料 | 本报告 + B5 系列 4 对 development/review + 全部 evidence 目录 + §5 文档翻转对照，齐备。 | 满足 |

**语义对齐核验（不构成削弱）**：套件接入揭示的三处 zcode 与共享契约差异均已对齐且方向更严或更精确——(1) 背靠背双轮先等终态再发（`#awaitTerminal` 以轮期限为界、上限 120s；intent 仍绝不自动重放）；(2) closed 句柄 `getResult` 返回 `state:"closed"`（不调宿主）、后续 runTurn/cancel 抛 `INVALID_STATE_TRANSITION`（原 NOT_FOUND 语义更精确化；closeSession 幂等 no-op）；(3) cancel 落 journal 标记（`cancelled_sessions` 表）使取消后拒绝一切新轮次——**这是把 B4"只发 stop 信号"收紧为符合 spec §7 明文（取消后不得再支出）**，迟到的在途轮仍由核心终态守卫拒收。`execution_key` 缺省自动生成对齐核心 TurnInput 类型事实，显式键幂等不变。

## 4. 独立验证

1. **独立门禁**：本机实跑 `npm run check`——**42 文件 / 449 测试全部通过，exit 0**（与开发方 `full-check.log` 一致；较 B5-3 增加的 10 项即契约套件用例；zcode 包 60/60 = 33 adapter + 10 contract + 14 sandbox + 3 process）。
2. **逃逸矩阵回归**：N2 修复后重跑 41/0 全过（开发方日志 + 本验收期内两次独立重跑一致）。
3. **B5-2 review 两项跟进**逐项验证完成（§2）。
4. mtime 核验证据后零改动；哈希清单 `host-components.sha256` 在案。

## 5. 裁定

### G01-Z03（四项隔离与真实角色闭环）——**关闭**

按 ADR-0012 语义（隔离由适配器自有执行边界强制）逐项对照原 P5-H 验收所列要求：

| 原要求 | 满足证据 |
| --- | --- |
| 宿主可执行工具 / MCP / 插件 / 嵌套工具范围限制 | 逃逸矩阵行 4/5/6/7：真实模型轮内 Bash 可运行而效果限边界内；嵌套三层 + 分离子进程 ns 边界不衰减；插件等价子进程同受约束；mount/unshare/setns EPERM、CapEff=0x400+NoNewPrivs（效果层强制，B5-2 全拦截 + 本验收两度独立重跑） |
| 临时工作区限制 | 行 1：白名单外写入 EROFS/ENOENT（根只读），白名单正向对照成功 |
| 上下文隔离 | 新会话 + 冻结材料载入（结构保证）+ 行 2 私有文件读取 ENOENT、credentials 未动 |
| 结果归属 | 协议层收件箱（既有）+ 零主会话注入显式断言（B5-3/B5-4 两链） |
| 完整角色链 + 10 重叠请求真实运行 | B5-4 八步全链（含步骤 5 继承、6 撤销、7 十重叠请求 84s、8 显式采纳）+ B5-3 独立链 |
| 正文/哈希、代次、收件箱、不注入、私人历史不迁移核对 | artifact 正文匹配、bundle 哈希链（B3 起）、generation 1→2 CAS、journal 三层审计一致 |

残余边界（如实记录，不构成缺口）：cgroup 资源上限为可选加固项（B5-2 review §4-1 裁定）；Windows/macOS 不支持；内核逃逸与同用户全权恶意代码在 ADR-0009/0012 威胁边界之外。八步链的主锚定会话经测试连接器运行（与 B3/B4/G-min 同形态；产品形态中主会话在桌面 app，不受沙箱影响）——此边界已在报告与链脚本头注如实声明。

### P5-H 与 P5 整体——**解除 BLOCKED**

四个门槛全部关闭：**Z01**（真人来源 + 会话身份：B1 验证 + B2 cli-console + G-min gui-confirm，均已独立验收）；**Z02**（材料载入与确认：B3 四判据 + 内容寻址 + journal 对账）；**Z03**（本报告裁定关闭）；**Z04**（取消/关闭/支出前预算：B4 + 八步链 seq 30→30）。P5-H 原验收的 H-R01 早已关闭，五项生产能力声明 + 四项隔离声明（受管）全部与真实证据绑定。

## 6. 结论与下一步

**B5-4 PASS；B5 系列收官；G01-Z03 关闭；P5-H 解除 BLOCKED；P5 整体通过。** `ADAPTER_SANDBOX_PLAN` 的目标全部达成。此验收不自动授予代码合并或远程发布权限。

下一步：(1) 本工作区自 P4 报告以来全部增量（P5-R/P5-A/P5-H/B0–B5）仍为未提交状态，建议所有者决定提交切分与提交（验收方不代行）；(2) 按阶段门顺序 **P6-G（桌面管理 GUI）可开工**——其前置"P5-H 复验通过"已满足；G-min 的浏览器人工点击流验收矩阵在 P6-G 正式验收时补齐（G-min review §4-1 已预留）；(3) 可选加固项（cgroup 上限、宿主转发器遥测）不阻塞任何阶段，按需另行立项。
