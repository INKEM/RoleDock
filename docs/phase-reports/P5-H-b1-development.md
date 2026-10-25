# P5-H 增量 B1 开发报告:契约预留与会话身份验证(含 B0)

日期:2026-10-24;状态:**待独立验收**。

按 ADR-0011 与已批准的 P5-H 收口计划执行首个增量 B0+B1。上一位验收入口:`docs/phase-reports/P5-H-review.md`(P5-H BLOCKED,G01-Z01~Z04 未关闭)。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(P4 报告之后的工作区,含 P5-R/P5-A/P5-H 未提交改动,见 `evidence/2026-10-24-p5-h-b1/baseline-status.txt`,50 个已改文件为前序阶段遗留,本增量在其上继续)。
- 组件哈希与版本:`evidence/2026-10-24-p5-h-b1/host-components.sha256`(官方 CLI 入口 `/opt/ZCode/resources/glm/zcode.cjs` sha256 `a055234a…`;注意其哈希与 P5-H 首轮记录 `31965ce1…` 不同,宿主 CLI 已更新,本轮以当前哈希为准)。

## 2. 交付与验收条件对应

**B0 契约预留**

| 交付 | 内容 |
| --- | --- |
| 新协议 Schema `human-authorization-event` | `packages/protocol/schemas/human-authorization-event.schema.json`:事件事实(workspace/subject/host/ref/actor/role/capabilities/inherit/expires_at,与核心端口逐字段对齐)+ 受信入口 provenance(entry: `cli-console`\|`gui-confirm`、recorded_at)。此类型此前只有 TS 端口定义、无 Schema。 |
| owner 面控制操作 `authorizations.submitHumanEvent` | `service-control-operation.schema.json` 新分支(flat 输入,workspace_id 由服务端填充)。这是 B2 服务实现与 G-min GUI 确认按钮的唯一写入面契约;**服务尚未实现,调用按既有未知操作拒绝,不假成功**。 |
| TS 镜像与端口统一 | `protocol/src/types.ts` 新增 `HumanAuthorizationEvent`/`HumanAuthorizationEventRecord`/`HumanAuthorizationEntry`;核心 `ports/adapter.ts` 删除本地重复定义,改为从 protocol 导入并转出(core 公共面不变)。 |
| 连接器工具契约 | `docs/zcode-connector-tools.md`:握手能力发现(tools/list)、凭据 helper 边界、4.1 既有三工具、4.2 `zcode_verify_session`、4.3 B3/B4 草案(load_material/lookup_load/cancel/close,实现前不声明)。 |
| 阶段文档修订 | `AGENTS.md`(2026-10-24 收口计划段)、`docs/DESKTOP_GUI_PLAN.md` §8(插入 P5-H 增量与 G-min 行)、`prompts/README.md`(续作顺序表)、`adapters/README.md`、`docs/zcode-integration.md`。 |

**B1 会话身份验证**

| 交付 | 内容 |
| --- | --- |
| 仓库内参考连接器 | `roledock-zcode-reference-connector`(v0.2.0,`adapters/zcode/src/reference-connector.ts` + `reference-bin.ts`):MCP stdio 服务器,内部 spawn 官方 CLI `app-server`(JSON-RPC over stdio),实现 4.1 三工具 + `zcode_verify_session`。CLI 入口经 `--cli`/`ZCODE_CLI_ENTRY` 注入,无默认路径;凭据经可选 `--credential-helper` 外包,仓库代码不读凭据存储,无 helper 时模型轮次如实失败。 |
| 客户端能力协商 | `connector.ts` 握手后 `tools/list` 发现工具面(5 秒防御超时,旧连接器降级空集=全部门禁拒绝);`ZCodeToolCaller` 增加可选 `tools`。 |
| 适配器验证 | `ZCodeAdapter.verifyExternalSession`:本地 sessionId 格式校验→工具声明门禁(`ADAPTER_CAPABILITY_MISSING`)→journal `identity_bindings` 首验固化 host↔subject 绑定、后续主体冲突确定性 false→连接器失败/畸形/工作空间回显不一致一律 uncertain→`identity_verifications` 审计留痕。 |
| 真实探针 | `roledock-zcode-probe --verify-session`:创建裸诊断会话(零模型轮次)→真实身份验证→伪造会话否定→主体冲突否定。 |

能力声明纪律:`external.current_session_identity` **保持 false**;本增量交付实现+真实证据,声明翻转留给独立验收通过后的后续增量。

## 3. 主要文件与公共接口变化

- 新文件:`packages/protocol/schemas/human-authorization-event.schema.json`、`packages/protocol/test/human-authorization-event.test.ts`、`adapters/zcode/src/reference-connector.ts`、`adapters/zcode/src/reference-bin.ts`、`adapters/zcode/test/reference-connector.process.test.ts`、`docs/zcode-connector-tools.md`、`docs/adr/0011-human-authorization-entry-reservation.md`。
- 修改:`packages/protocol/src/types.ts`、`validate.ts`(SchemaName 注册)、`packages/core/src/ports/adapter.ts`(HumanAuthorizationEvent 改协议导入)、`packages/protocol/schemas/service-control-operation.schema.json`、`adapters/zcode/src/index.ts`(`ZCodeToolCaller.tools`、journal 两张新表、`verifyExternalSession`)、`connector.ts`(工具发现)、`bin.ts`(`--verify-session`)、`tests/integration/helpers/zcode-connector-fixture.mjs`(补 tools/list 应答)及 §1 所列文档。
- 无新依赖;工具链不变(Node 22.23.2,`@modelcontextprotocol/sdk` 沿用已锁定的 1.32.1)。

## 4. 实际运行与证据(`docs/phase-reports/evidence/2026-10-24-p5-h-b1/`)

- 构建+协议测试:`npm run build`、`npx vitest run packages/protocol/`(84 项,含 3 项新契约测试)通过。
- 全量门禁 `npm run check`:typecheck + 396 测试;首轮 395 过 1 挂(见 §5 修复),修复后全绿,终轮日志 `full-check.log`。
- 真实身份验证探针(官方 CLI app-server + 参考连接器,零模型轮次):
  - `real-verify-session.log`(Run1,全新 workspace/journal):连接器 v0.2.0 握手、tools 发现 4 项;真实会话 `sess_02b11c72-7acf-46fc-a07d-0de413a614ef` `verified:true`;伪造会话 `absent_session_exists:false`;主体冲突 `subject_conflict_confirmed_false:false`;exit 0。
  - `real-verify-session-rerun.log`(Run2,同 journal):`verified:false`——见 §5 边界发现,诚实否定而非缺陷。
  - `journal-dump.txt`:journal 审计(1 条绑定、6 条验证记录:true×1、false×5,时间戳齐全)。
  - `diagnostics-journal.sqlite`:journal 原件副本;`host-components.sha256`:CLI/连接器/适配器 dist 哈希。

## 5. 失败、边界发现与未验证项

1. **首轮全量门禁 1 挂(已修复)**:`zcode-diagnostic-cleanup` 集成测试的夹具连接器不应答 `tools/list`,新增的发现调用挂起至超时。修复=夹具补应答 + 客户端发现加 5s 防御超时(旧连接器降级空集,门禁拒绝,不假设支持)。
2. **真实边界发现(已固化为契约)**:官方 `session/read` 对未附接会话报 "Session is not active"(非确定性),`session/list` 不列未附接会话(非否定);权威存在性判据是 `session/resume`,其官方 "Session not found" 才构成确定性否定。参考连接器 verify 据此设计(resume-first),契约写入 `docs/zcode-connector-tools.md` §4.2。
3. **零轮次会话不跨 app-server 实例存活**:经子进程 app-server 以 `persistence:"immediate"` 创建的零轮次会话,子进程终止后 resume 返回官方 "Session not found"。Run2 的 `verified:false` 即此事实的诚实呈现。真实闭环锚定的桌面会话(有轮次、随桌面存活)预期不受影响,**该假设留待 B3 锚定会话验证时复验**。
4. **未验证/未声明(如实)**:`verifyExternalSession` 未被核心 register 路径消费(声明 false,核心门禁照旧,测试断言 `ADAPTER_CAPABILITY_MISSING` 不变);`zcode_send`/`zcode_status` 未经真实模型轮次(本轮零支出);四项隔离、真人授权、材料载入、cancel/close 均未实现或未证实;ZCode 适配器仍因 bootstrap/cancel/close 不进 `tests/conformance/adapter-suite.ts` 套件。G01-Z01~Z04 全部未关闭。

## 6. 规范与 ADR 更新

- 新增 ADR-0011(真人授权入口预留为内部受信接口;G-min 自 P6-G 提前;entry 枚举即受信入口注册表;威胁边界沿用 ADR-0009)。
- 新增 `docs/zcode-connector-tools.md`(连接器工具契约,含 B1 实测边界)。
- 修订 `AGENTS.md`、`docs/DESKTOP_GUI_PLAN.md` §8、`prompts/README.md`、`adapters/README.md`、`docs/zcode-integration.md`。契约对象 Schema 为代码侧权威,`docs/spec/external-session-anchor.md` 的流程描述不受影响。

## 7. 下一阶段可用输入与未满足退出条件

- **B2(真人授权入口内部接口)可直接开工**:Schema 与 owner 操作契约已固化;需实现工作空间事件存储+迁移、`authorizations.submitHumanEvent` 服务实现、CLI 所有者写入命令、`ZCodeAdapter` 的 `HumanAuthorizationSource` 内部接口与 `readHumanAuthorization`;`human_authorization_events` 翻转条件=受信写入面真实事件+recordHuman 全链+独立验收。
- **声明翻转待办**:独立验收通过 B1 后,后续增量将 `external.current_session_identity` 置 true(一行改动+测试断言更新),register 路径随即对真实 ZCode 会话开放。
- **未满足退出条件**:P5-H 原验收链(05H 八步)全链未跑通;G01 仍 BLOCKED;本增量通过不代表 P5-H 收口。
