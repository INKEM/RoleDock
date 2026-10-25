# P6-G-min 开发报告:GUI 最小授权确认面(自 P6-G 提前)

日期:2026-10-24;状态:**待独立验收**。

按 ADR-0011 与已批准的 P5-H 收口计划执行 G-min(阶段门修订:自 P6-G 提前,作为 G01-Z01 真人来源的受信入口)。前置:B1/B2/B3 的独立验收均尚待进行(所有者指示连续续作)。上一位验收入口:`docs/phase-reports/P5-H-b3-development.md`。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(同一工作区,含 B0–B3 未提交改动;`evidence/2026-10-24-p5-h-gmin/baseline-head.txt`)。
- 官方 CLI 入口 sha256 `a055234a…`(与 B1–B3 一致);组件哈希 `host-components.sha256`。

## 2. 交付与验收条件对应

| 计划项(ADR-0011 / DESKTOP_GUI_PLAN §8) | 交付 |
| --- | --- |
| 授权请求列表 → 确认/拒绝入口 | `packages/desktop`(bin `roledock-desktop-gmin`):受信 owner 进程读取 service 写出的 owner-connection.json(属主+0600 校验),在 127.0.0.1 服务确认页;页面列出已注册外部会话(host/主体/现存有效授权),逐会话选择角色/能力(按角色 requested_capabilities 预填)/继承/有效期后确认;拒绝=不操作(协议无拒绝对象,不虚构)。确认调用 `authorizations.submitHumanEvent`,entry 固定 `gui-confirm`,event_ref 由受信进程生成(`gui-<时间>-<随机>`),actor `owner`。 |
| 调 submitHumanEvent;复用 owner credential 与 ServiceClient | 服务面:owner 专用;新增 owner 读操作 `externalSessions.list`(Schema 先行:`service-control-operation` 扩展,空输入;核心 `ExternalSessionAuthority.listExternalSessions` 返回会话+live 授权摘要,撤销以列为准)。确认的 host/subject 由服务端从列表解析(页面不可伪造),已有效授权的会话拒绝重复确认(INVALID_STATE_TRANSITION)。 |
| 渲染层无写库/宿主命令/所有者凭据 | 信任分割:Node 进程持有凭据并代理且仅代理三个操作;页面零凭据、零写库、零宿主命令(测试断言页面不含 token);API 为同源 loopback JSON,请求体 256KiB 上限。 |
| 桌面容器/IPC 基线技术验证 | 基线落定:Node 内置 http + 纯浏览器页面(无框架、无外部资源、零新增依赖),记录于 `docs/toolchain.md` "G-min 桌面确认面技术基线";完整桌面容器与五页面仍属 P6-G。 |
| 真实 ZCode 会话上 GUI 确认 → recordHuman(human-event)→ sessions.anchor 全链 | 见 §4:service(真实 zcode 适配器)→ owner-connection 引导 → GUI 页面/视图/确认 → 受信通道 recordHuman(source.kind=human-event,生产声明)→ Agent 会话 `sessions.anchor` → **真实材料载入轮 → attempt active、binding active generation 1**。 |

## 3. 主要文件与公共接口变化

- 新增包 `packages/desktop`:`src/index.ts`(确认面服务器 + 内嵌页面 + confirmInput 校验)、`src/bin.ts`(owner-connection 引导)、`test/desktop.test.ts`(3 用例);workspace 依赖 `@roledock/service`/`@roledock/protocol`(均为既有内部包,零外部新依赖),根 tsconfig references 增补。
- 修改:`packages/protocol/schemas/service-control-operation.schema.json`(`externalSessions.list`)、`packages/core/src/sessions/anchor.ts`(listExternalSessions;撤销状态以列为准)、`packages/service/src/index.ts`(owner 分发)。
- 测试:core +1(G-min 读视图:列表→授权→撤销)、service +1(owner 面可用/trusted 拒绝)、desktop 3 用例(页面无凭据、代理与确认 provenance、重复/未知/畸形拒绝且零写面调用)。
- 文档:`docs/toolchain.md`(G-min 技术基线)、`docs/DESKTOP_GUI_PLAN.md` §8(G-min 行标注交付)、`AGENTS.md`(仓库结构)。

## 4. 实际运行与证据(`docs/phase-reports/evidence/2026-10-24-p5-h-gmin/`)

`gmin-e2e.mjs`(证据 runner,范围:本地)+ `1-gmin-e2e.log`:

1. `WorkspaceService` 以**真实 zcode 适配器**启动,owner-connection.json(0600)引导;真实会话 `sess_7106c2f9…` 经受信通道注册(`externalSessions.register`,生产 `current_session_identity: true`)。
2. GUI 服务器启动(127.0.0.1 随机端口);`GET /` 返回确认页(含 gui-confirm 与 sessions.anchor 字样);`GET /api/sessions` 显示 1 个会话、无有效授权。
3. **GUI 确认**(页面的确认按钮即该 POST):`{ok:true, event_ref:"gui-1792795205684-9a1630", entry:"gui-confirm"}`。
4. 受信通道 `recordHuman` → 授权 `auth-12cccec0…`,source `{kind:"human-event", event_ref:"gui-…"}`(生产声明);Agent 会话 `sessions.anchor` → **真实材料载入轮 → attempt active、confirmation load_version 1、binding active generation 1**(载入声明为 fixture 翻转,输出注明,生产翻转随 B4 验收)。
5. `GET /api/sessions` 复核:该会话显示有效授权(角色/到期/来源)。
6. `2-store-dump.txt`:核心 store(attempt/binding/授权/事件,entry=gui-confirm)与连接器 journal 三层审计一致。

测试门禁:desktop 3 项、core G-min 1 项、service G-min 1 项全过;最终全量 `npm run check`:**40 文件 / 415 测试全部通过**(过程中修复测试类型标注与两处测试暴露的产品/测试缺陷,见 §5),日志 `full-check.log`。

## 5. 失败、边界与未验证项

1. **开发中修复**:服务读操作返回裸数组而桌面 API 包装 `{external_sessions}`(测试暴露,处理器统一归一);listExternalSessions 撤销状态需以 revoked_at 列为准(record_json 不随撤销更新,测试暴露)。
2. **诚实边界**:载入声明在证据链中为 fixture 翻转(生产翻转随 B4 验收,输出已注明)——G-min 关闭的是 G01-Z01 的 GUI 侧入口,不夸大为隔离或载入能力证明;**拒绝(decline)不落任何记录**——协议无拒绝对象,页面拒绝=不操作,不虚构"已拒绝"状态。
3. **威胁边界**(ADR-0011/ADR-0009 沿用):GUI 确认入口的可信度来自 owner 凭据与受信进程,同机可读用户全部文件/内存的恶意代码不在防御范围内;`actor_id` 记为 `owner`,不声称密码学级真人在场。
4. **未验证/未实现**:浏览器人工点击流程(证据经与页面同一 HTTP 端点采集,页面 JS 为静态资源已随证据留档);多会话/多角色并发确认、跨工作空间多服务并行、键盘可达性与空状态细节属 P6-G 验收矩阵;G01-Z03/Z04 未动。
5. 首轮运行曾出现 attempt failed(生产载入声明门禁按设计拒绝),以 fixture 翻转重跑后全链 active——两次运行日志均在,如实呈现。

## 6. 规范与 ADR 更新

- ADR-0011 已固化 G-min 决策,本增量为实现交付;无新架构决策。
- `docs/toolchain.md` 新增 G-min 技术基线段;`docs/DESKTOP_GUI_PLAN.md` §8 G-min 行标注交付(待独立验收);`AGENTS.md` 仓库结构补 `packages/desktop`。

## 7. 下一阶段可用输入与未满足退出条件

- **B4(隔离实证+资源控制+P5-H 收口)可开工**:官方 `session/stop`/`session/close` 已取证;`load_materials`/`reconcile_load` 翻转后生产锚定无需 fixture;05H 八步已完成前四步(GUI 确认形态现已就位)。
- **G01-Z01**:GUI 确认入口(本增量)+ 真实链证据已具备,按计划在 P5-H 复审中关闭;真人点击流程的验收属 P6-G 正式验收矩阵。
- **未满足退出条件**:G01-Z03(隔离)/Z04(资源控制)未动;P5 整体仍 BLOCKED;本增量通过不等于 P6-G 开工(其前置为 P5-H 复验通过)。
