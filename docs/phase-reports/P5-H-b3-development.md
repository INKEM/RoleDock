# P5-H 增量 B3 开发报告:材料载入与对账(G01-Z02)

日期:2026-10-24;状态:**待独立验收**。

按 ADR-0011 与已批准的 P5-H 收口计划执行第三个增量 B3。前置:B1/B2 的独立验收均尚待进行(所有者指示连续续作);本增量建立在 B1/B2 交付之上。上一位验收入口:`docs/phase-reports/P5-H-b2-development.md` 与 `docs/phase-reports/P5-H-review.md`。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(同一工作区,含 B0–B2 未提交改动;`evidence/2026-10-24-p5-h-b3/baseline-head.txt`)。
- 官方 CLI 入口 sha256 `a055234a…`(与 B1/B2 一致);组件哈希 `host-components.sha256`(含凭据 helper 工件)。

## 2. 交付与验收条件对应

| 计划项 | 交付 |
| --- | --- |
| 接口核查(05H:不猜私有 API) | 官方 CLI bundle 协议面取证:app-server RPC 全集(session/create|send|read|events|list|messages|resume|subscribe|stop|close|fork|compact 等);**无上下文注入专用 RPC**——材料载入只能走 turn 通道;`session/send` 强制 `modelSelection.providerId/modelId`(Zod);**`session/events` 不回放 resume 前历史**(跨实例对账边界)。真实事件形状取证:text turn 与 tool turn(Read 工具结果 `result.content` 含文件内容、`truncated` 标志、`success` 标志)。 |
| 参考连接器载入/对账 | `zcode_load_material`(intent 先行落库 → 载入协议轮 → marker)与 `zcode_lookup_load`(活实例事件窗口验证 → journal 重放);载入确认四判据(见 `docs/zcode-connector-tools.md` §4.3):唯一 turn.started 含载入头 + 成功未截断的工具结果携带材料头(结构性"宿主真实读取") + 终态响应精确标记行 + load_version 序号;失败/缺失一律 `unknown` 并附 reason。连接器新增 `--journal`(载入持久 journal,跨实例恢复)与 `--provider/--model`(`--provider` 缺省取 helper 应答的 `preferred`)。凭据 helper 契约扩展 `{bootstrap:{builtinPath}}` → `provider/updateAccountConfig` 注册参数(无密钥),并在 app-server 子进程每次(重)启动后重执行(注册表随子进程生命周期清空——实测缺陷修复)。 |
| 适配器载入/对账 | `loadExternalMaterials`:payload 哈希预校验 → 内容寻址材料文件(头两行 `roledock-anchor-load/<key>` + `sha256:<hash>`,正文为完整 bootstrap payload)→ 发送 → 300s 轮询(宿主待人请求即 uncertain)→ `zcode_lookup_load` 权威确认 → AnchorConfirmation 严格四字段。`lookupExternalLoad`:无本地 intent → `absent`;loading → 对账(loaded/unknown);confirmed → 重放。适配器 journal 新表 `material_loads`。 |
| 声明翻转(计划内) | `human_authorization_events: false → true`(B2 真实链路证据背书,B2 报告 §7 预告);`load_materials`/`reconcile_load` **保持 false**(本增量证据待验收后于 B4 翻转),真实锚定激活探针以 fixture 翻转子类运行(输出已注明)。 |

## 3. 主要文件与公共接口变化

- `adapters/zcode/src/reference-connector.ts`(v0.3.0):两个新工具、载入协议窗口验证、journal、provider 注册引导、事件历史收集。
- `adapters/zcode/src/index.ts`:`loadExternalMaterials`/`lookupExternalLoad` + `material_loads` 表 + 声明更新。
- `adapters/zcode/src/bin.ts`:`--anchor-e2e` 模式(注册→真人事件→recordHuman→sessions.anchor 全链)与 `--connector-arg` 透传。
- `adapters/zcode/src/connector.ts`:连接器错误文本透传(`details.connector_error`,诊断用途)。
- `tests/integration/helpers/zcode-connector-fixture.mjs` 无变化;文档:`docs/zcode-connector-tools.md` §3/§4.3 定稿 + §4.4 B4 草案、`docs/zcode-integration.md`、`adapters/README.md`。无新依赖;工具链不变。

## 4. 实际运行与证据(`docs/phase-reports/evidence/2026-10-24-p5-h-b3/`)

**真实锚定激活链(anchor-e2e,工作空间 ws-946…,含 1 个真实模型轮次)**:

1. `1-anchor-e2e.log`:真实会话 `sess_da293c91…` 创建并以生产声明注册;真人确认事件经 owner 面写入(entry `cli-console`,生产声明 `human_authorization_events: true`);recordHuman 产出授权(source `human-event`);`sessions.anchor` 驱动 **真实材料载入轮**(GLM-5.3 读取内容寻址材料文件)→ 四判据确认(load_version 1)→ **CAS 激活**:attempt `active`、binding `active` generation 1、capabilities `["documents.read"]`。这是 05H 验收链"用户授权→Agent 显式锚定→当前会话载入固定材料→事务激活"四步的真实宿主证据。
2. `2-store-dump.txt`:核心 store(attempt active/binding generation 1/授权 source_key) + 连接器 journal(confirmed) + 适配器 journal(confirmed) 三层审计一致。
3. `3-material-header.txt`:材料文件头部(载入键 + sha256)。
4. 接口核查事件形状取证:`/tmp/b3-invest/event-shapes.json`、`tool-event-shapes.json`(调查脚本 `probe5/6/7.mjs`,结论固化进契约 §4.3)。
5. `credential-helper.mjs`:证据运行工件(不在任何 package 内;桥接参考连接器 helper 契约与本机 ZCode 账户存储,机制与用户现有 zcode-delegation 相同;已哈希留档)。

测试门禁:zcode 26 项(含 B3 全链 fixture 测试:锚定 CAS 激活、载入门禁、篡改拒绝、unknown 不假确认);全量 `npm run check` 见 `full-check.log`。

## 5. 失败、边界发现与未验证项

调试过程中定位并修复的真实边界(均有复现日志):

1. **官方 `session/send` 强制 provider/model**(Zod 校验)——参考连接器原实现会失败,已补 `--provider/--model` 注入 + helper `preferred` 缺省。
2. **provider 注册表随 app-server 子进程生命周期清空**——`provider/updateAccountConfig` 引导必须在子进程每次(重)启动后重执行;实测缺陷(subprocess 重启后 send 报"Provider Registry 中不存在")已修复。
3. **`session/events` 不回放 resume 前历史**——跨实例对账不能依赖宿主事件流重放;连接器 `--journal` 持久化载入 intent/确认,恢复路径由 journal 权威重放。
4. **高推理档载入轮超出初始 150s 轮询期限**——载入轮改 low reasoning(机械读文件任务)+ 结构化判据兜底防伪造 + 期限 300s + 宿主待人请求即时 uncertain。
5. **诚实边界**:载入确认证明"宿主会话真实读取并回显了材料",**不证明**工具范围隔离(G01-Z03,属 B4);`absent` 语义现以连接器 journal 为准(journal 无 intent = 未发生);B1 的"零轮次会话不跨实例存活"边界与之一致(载入轮使会话持久化)。四次失败运行(Provider 注册/超时/解析)均以 uncertain/failed 如实落地,未产生假成功。
6. **未验证/未声明**:`load_materials`/`reconcile_load` 生产声明仍 false(验收后 B4 翻转);知识漂移重备(revision 变化→新 bundle/load_key)未实测;10 重叠请求、交接、跨 Harness 迁移未动(G01-Z03/Z04 属 B4);G01 仍 BLOCKED。

## 6. 规范与 ADR 更新

- 无新架构决策(ADR-0011 框架内续作);`docs/zcode-connector-tools.md` §3(helper 双形态+journal)/§4.3(定稿:工具契约+四判据+时序边界)/§4.4(B4 草案:官方 session/stop、session/close 已在接口核查中确认存在)。
- `docs/zcode-integration.md`、`adapters/README.md` 状态行更新。

## 7. 下一阶段可用输入与未满足退出条件

- **B4(隔离实证+资源控制+收口)可开工**:官方 `session/stop`/`session/close` RPC 已取证(§4.4 草案);`load_materials`/`reconcile_load` 与 `human_authorization_events` 一样具备翻转条件;隔离实证(G01-Z03)需官方工具范围机制取证;05H 八步全链复验在本增量已完成前四步。
- **声明翻转待办**:`load_materials`/`reconcile_load` 于 B4 翻转后,生产路径即可完成真实锚定(无需 fixture 翻转)。
- **未满足退出条件**:G01-Z01 的真人来源仍是 cli-console 受信本地面(gui-confirm 属 G-min);G01-Z03/Z04 未关闭;P5-H 仍 BLOCKED,本增量通过不代表收口。
