# P5-H-b4 开发报告:资源控制、继承与 05H 链复验(G01-Z04 收口证据;G01-Z03 残余如实 BLOCKED)

日期:2026-10-24;状态:**待独立验收**。

按 ADR-0011 与已批准的 P5-H 收口计划执行收口增量 B4。前置:B1/B2/B3 与 G-min 的独立验收均尚待进行(所有者指示连续续作)。本报告同时是 05H 验收链的复验记录:验收链八步中 **1–6 步已在真实 ZCode 宿主以生产声明全部跑通**,7–8 步按设计诚实拒绝(G01-Z03 残余),G01 整体保持 BLOCKED——范围从"全链未证实"收敛到"仅隔离声明未证实"。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(同一工作区,含 B0–B3/G-min 未提交改动;`evidence/2026-10-24-p5-h-b4/baseline-head.txt`)。
- 官方 CLI 入口 sha256 `a055234a…`(与 B1–B3/G-min 一致);组件哈希 `host-components.sha256`。

## 2. 交付与验收条件对应

| 计划项(ADR-0011/DESKTOP_GUI_PLAN §8) | 交付 |
| --- | --- |
| `zcode_cancel`/`zcode_close`(官方支持则实现) | 官方 `session/stop`(中止当前轮,空闲时诚实 no-op)与 `session/close`(宿主删除其事件存储,`closed` 原样上报)已实现;适配器 `cancel`(声明 `optional.cancel: true`)与 `closeSession`(closed:true 后句柄失效、按创建键查询返回 null;closed:false 与信号丢失均 uncertain)。取消/关闭的连接器失败一律 uncertain,不假设宿主状态。 |
| `createSession` 带 bootstrap(解锁继承) | intent 先行落库 → 裸会话创建 → 内容寻址材料文件 + **真实载入轮 + 四判据确认**后才返回句柄(复用 B3 载入机械);`capability_scope`/`temp_dir` 仍 NOT_IMPLEMENTED。解锁 `sessions.open inherit=latest` 跨会话继承(实测 generation 2 交接,新宿主会话真实载入)。 |
| 声明翻转(计划内) | `load_materials`/`reconcile_load: false → true`(B3 真实锚定证据背书,B3 报告 §7 预告);`cancel: false → true`(本增量真实取消证据)。**四项隔离保持 false**(见 §5 隔离残余)。 |
| 支出前预算 | 真实证据:过期 deadline 的发送在宿主调用前被拒,宿主事件序列号不变(34→34 / 26→26,零支出);既有 max_output_bytes 超限拒收与 max_turns 边界测试继续通过。 |
| 隔离实证(G01-Z03) | plan 模式写尝试实验(`2-isolation-cancel.log`):写尝试轮在运行中经官方 stop 中止,**目标文件始终不存在**,连接器从不自动应答权限请求。**诚实边界**:未观察到 permission 阶段(轮在工具调用前被中止),工具范围与嵌套 Agent 约束仍未证明——四项隔离不翻转,残余如实 BLOCKED。 |
| 05H 验收链复验 | 见 §4:八步中 1–6 真实跑通(3 次真实材料载入轮),7–8 按设计拒绝(隔离门禁,零宿主轮次)。 |

## 3. 主要文件与公共接口变化

- `adapters/zcode/src/reference-connector.ts`:`zcode_cancel`/`zcode_close` 工具 + `cancelTurn`/`closeSession`。
- `adapters/zcode/src/index.ts`:能力声明更新(`load_materials`/`reconcile_load`/`cancel` = true)、`createSession` 支持 bootstrap、`cancel`/`closeSession` 实现。
- `adapters/zcode/test/zcode-adapter.test.ts`:B1/B3 时代断言更新;新增 B4 describe(cancel/close 语义、bootstrap 创建初始化角色、fixture 级交接 gen2+旧主 superseded 视图)。29/29 通过。
- 文档:`docs/zcode-connector-tools.md` §4.4 定稿;`docs/zcode-integration.md`、`adapters/README.md` 状态行。无新依赖;工具链不变。
- conformance 套件:zcode 仍未加入 `defineAdapterContractSuite`——套件的 `make()` 工厂语义要求全能力参考实现,zcode 诚实受限(仅 restricted),不伪造全能力变体;其契约行为由自身的 fixture 测试覆盖(29 项)。

## 4. 实际运行与证据(`docs/phase-reports/evidence/2026-10-24-p5-h-b4/`)

**05H 验收链(`1-chain.log` + `3-store-dump.txt`,生产声明,3 个真实材料载入轮)**:

| 步骤 | 结果 |
| --- | --- |
| 1 真人授权 | owner 面真人事件(entry cli-console;GUI 表单形态已在 G-min 以 gui-confirm 真实证明) |
| 2 Agent 显式锚定 | 生产声明注册 → recordHuman(source human-event)→ `sessions.anchor` |
| 3 载入固定材料 | attempt active,load_version 1(真实模型轮) |
| 预算(支出前) | 过期 deadline 拒绝,宿主 seq 34→34 不变 |
| 4 正式角色动作 | 经绑定连接 propose(cand-b67c91443a)+ publish → `documents.state` revision 1 |
| 5 新会话继承 | 新 ZCode 会话以 takeover 授权锚定 → **第二次真实载入轮** → generation 2、旧实例 retired/旧 binding 视图 superseded |
| 6 旧主撤权 | `authorizations.revoke` → 旧授权 revoked_at、旧 binding 视图 revoked、successor 保持 generation 2 |
| 7 独立请求 ×10 | **按设计拒绝**:全部 failed,`ADAPTER_CAPABILITY_MISSING "Independent requests require all four isolation scopes."`,零宿主咨询轮次 |
| 8 收件箱采纳 | 无 artifact 可采纳(7 被拒的直接后果)——残余如实呈现 |

`3-store-dump.txt`:attempts×2 active、bindings(gen1 revoked / gen2 active)、instances(builder gen1 retired、gen2 active、reviewer gen1 active)、documents revision 1、requests 全 failed 带隔离门禁错误、connector/adapter journal 一致。

**隔离与取消实验(`2-isolation-cancel.log`)**:plan 模式会话写尝试 → 轮运行中经官方 `session/stop` 中止 → 状态回 idle → **目标文件始终不存在**;连接器从不自动应答权限请求。作为 G01-Z03 的部分证据与残余边界一并记录(未观察到 permission 阶段——轮在工具调用前被中止)。

测试门禁:zcode 29/29;最终全量 `npm run check`:**40 文件 / 418 测试全部通过**(`full-check.log`)。

## 5. 失败、边界与未验证项

1. **开发中修复**:closeSession/cancel 的连接器失败原样穿透——已包 uncertain(信号未确认=宿主状态未知);closed 句柄的按创建键查询返回 null(回收语义);交接测试初版断言了 DB 行而非规范语义的 binding 视图(视图惰性重算,anchor.ts:149)——修正为视图断言。handoff 激活路径的旧实例状态为 `retired`(与锚定路径的 `superseded` 措辞不同,均为失去主实例资格;语义差异留独立验收裁定)。
2. **G01-Z03 残余(如实 BLOCKED)**:四项隔离未声明——plan 模式与权限流是部分证据,工具范围强制与嵌套 Agent 约束未证明;独立请求/收件箱采纳因此按设计拒绝(实测)。这是 ZCode 平台侧需要官方工具范围机制的缺口,非本仓库可实现项。
3. **G01 各门槛现状**:Z01(真人来源+会话身份)与 Z02(材料载入确认)有完整真实证据,可评审关闭;Z04(取消/关闭/支出前预算)有实现+真实证据,可评审关闭;**Z03 保持 BLOCKED → G01 整体仍 BLOCKED**,P5-H 不虚称收口。
4. **未验证**:conformance 套件未纳入 zcode(理由见 §3);真实预算超支轮的拒收(仅 fixture 证据 + 真实支出前拒绝);嵌套 Agent/插件 MCP 的隔离行为;多工作空间并行。

## 6. 规范与 ADR 更新

- 无新架构决策(ADR-0011 框架内续作);`docs/zcode-connector-tools.md` §4.4 定稿(cancel/close 语义 + bootstrap 创建 + 声明现状)。
- `docs/zcode-integration.md`、`adapters/README.md` 状态行更新。

## 7. 下一阶段可用输入与未满足退出条件

- **P5-H 整体现状**:G01 四门槛中 Z01/Z02/Z04 具备关闭证据,Z03 保持 BLOCKED。独立验收 Agent 可按本报告与 B1–B3/G-min 各报告逐项裁定:若裁定 Z03 需宿主侧官方机制(本仓库外),P5-H 的剩余缺口即收敛为单一外部依赖项。
- **P6-G 前置未满足**:P6-G 仍前置 P5-H 复验通过;G-min 的 GUI 确认面已提前交付但五页面/桌面容器未动。
- 本增量通过不代表 G01 关闭;不得依据本报告宣称"真实角色闭环完成"——隔离声明未证实前,独立请求与完整产品闭环仍被核心门禁如实拒绝。
