# P5-H 增量 B2 开发报告:真人授权入口内部接口

日期:2026-10-24;状态:**待独立验收**。

按 ADR-0011 与已批准的 P5-H 收口计划执行第二个增量 B2。前置说明:所有者指示直接续作,B1 的独立验收尚待进行,本增量建立在 B1 交付之上(参考连接器、`verifyExternalSession`、`current_session_identity` 证据)。上一位验收入口:`docs/phase-reports/P5-H-b1-development.md` 与 `docs/phase-reports/P5-H-review.md`。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(与 B1 相同的工作区,含 B1 未提交改动;见 `evidence/2026-10-24-p5-h-b2/baseline-head.txt`)。
- 组件哈希:`evidence/2026-10-24-p5-h-b2/host-components.sha256`(官方 CLI 入口 sha256 `a055234a…`,与 B1 一致)。

## 2. 交付与验收条件对应

| 计划项 | 交付 |
| --- | --- |
| 事件存储 | 迁移 7 `human_authorization_events`(`packages/core/src/store/migrations.ts`):事件事实 + entry CHECK(`cli-console`\|`gui-confirm`)+ provenance(input_hash 幂等);读路径索引 (workspace, host_session_id, event_ref) 对齐适配器端口入参。 |
| `authorizations.submitHumanEvent` 实现 | 核心 `ExternalSessionAuthority.submitHumanEvent`(`anchor.ts`):B0 Schema 校验→外部会话存在性与 host/subject 一致性→事件事实哈希幂等(同 ref 同事实返回原记录,事实变更 `IDEMPOTENCY_CONFLICT`)。**entry/recorded_at 属首次写入 provenance,不参与哈希**——任何受信入口重放同一确认都返回原记录。服务控制面 owner 专用分发(`packages/service/src/index.ts`),trusted/session 面拒绝。 |
| CLI 受信写入面 | `roledock admin submit-human-event <ext-session> <host-session> <subject> <event-ref> <actor> <role> <caps.csv> <initialize|takeover> <expires-at>`(entry 固定 `cli-console`,recorded_at 写入时刻);独立开库执行,退出码沿用 0/1/2 约定。 |
| 适配器读取口 | 核心 `HumanAuthorizationSource` 端口 + `storeHumanAuthorizationSource` 读视图 + **authority 构造时自动接线**(结构化可选 `useHumanAuthorizationSource`,mock/bridge 不受影响);`ZCodeAdapter.readHumanAuthorization` 返回事件事实(host/ref 本地校验,无 source 时 `NOT_IMPLEMENTED`,workspace/subject/天花板一致性由核心 recordHuman 执行)。 |
| 声明翻转(计划内) | `current_session_identity: false → true`(B1 真实探针证据背书,B1 报告 §7 预告);`human_authorization_events` **保持 false**,翻转条件=本增量验收通过。 |

## 3. 主要文件与公共接口变化

- 修改:`packages/core/src/store/migrations.ts`(迁移 7)、`packages/core/src/sessions/anchor.ts`(submitHumanEvent/humanEvent/storeHumanAuthorizationSource/构造接线)、`packages/core/src/ports/adapter.ts`(HumanAuthorizationSource + 可选 useHumanAuthorizationSource)、`packages/core/src/index.ts`(导出)、`packages/service/src/index.ts`、`packages/cli/src/cli.ts`(AUTHORITY_METHODS 分支 + USAGE)、`adapters/zcode/src/index.ts`(source 注入 + readHumanAuthorization + 声明翻转)、`adapters/zcode/src/bin.ts`(`--human-event stage|record`)、`packages/core/test/store.test.ts`(迁移计数 6→7)。
- 新增测试:`packages/core/test/b2-human-events.test.ts`(4 用例)、zcode B2 describe(2 用例)、service B2 describe(1 用例)、cli B2 describe(1 用例)。
- 文档:`docs/zcode-integration.md`、`adapters/README.md` 状态行更新。无新依赖;工具链不变。

## 4. 实际运行与证据(`docs/phase-reports/evidence/2026-10-24-p5-h-b2/`)

真实四步链(官方 CLI app-server + 参考连接器,**零模型轮次**;工作空间 `ws-f33a9803`):

1. `1-stage.log`:探针 `--human-event stage`——创建真实会话 `sess_e1072ab3…` 并以**生产声明**(`current_session_identity: true`)经 authority.register 注册为 `ext-ee4d105e…`(天花板 documents.read);真实 resume 验证通过。
2. `2-cli-write.log`:owner CLI 安装 demo-team 角色包;`admin submit-human-event` 写入真人确认记录(entry `cli-console`);**幂等重放返回首次 recorded_at**(first-write-wins provenance 生效)。
3. `3-record.log`:探针 `--human-event record`——recordHuman 全链在真实 store+适配器上跑通,产出授权 `auth-717d12c7…`,source `{kind:"human-event", event_ref:"human-confirm-b2-001", actor_id:"human-user"}`。此步使用 fixture 范围的声明翻转子类(EventChainProbeAdapter,输出中已注明)。
4. `store-dump.txt` / `state-store.sqlite`:审计留痕——迁移 1–7 全应用;`human_authorization_events` 恰一条;`role_authorizations` 的 source_key 为 `[ext…,"human-event","human-confirm-b2-001"]`。

测试门禁:`npm run build` + typecheck 全绿;B2 相关套件(core B2 4 项、zcode 20 项、service 12 项、cli 22 项)通过;最终全量 `npm run check`:**39 文件 / 404 测试全部通过**(typecheck 含 tests 全量;过程中修复两处测试类型错误与一处 CLI 退出码期望,见 §5),日志 `full-check.log`。

## 5. 失败、边界与未验证项

1. **开发中修复**:CLI 测试首版持有 coordinator 锁导致 CLI 开库冲突(测试结构问题,非产品缺陷);submitHumanEvent 幂等哈希最初包含 recorded_at,使任何重放必冲突——已修正为仅覆盖事件事实,并补"不同入口/时间重放返回原记录"断言。
2. **迁移计数测试更新**:store.test.ts 的迁移数断言 6→7,属预期更新。
3. **诚实边界**:`human_authorization_events` 生产声明仍为 false——核心 recordHuman 对 ZCode 适配器仍返回 `ADAPTER_CAPABILITY_MISSING`;真实 recordHuman 证据中该声明为 fixture 翻转,已在输出与报告中如实标注。真人来源的最终受信入口是 G-min 的 gui-confirm;`cli-console` 是受信本地写入面(ADR-0011 威胁边界内),不声称密码学级真人在场证明。
4. **未验证/未实现**:隔离四项、材料载入(B3)、cancel/close(B4)未动;owner-selection 降级路径未改变(既有测试继续通过);G01-Z01~Z04 全部未关闭。

## 6. 规范与 ADR 更新

- ADR-0011 已于 B0 固化,本增量是其实现交付,无新架构决策。
- `docs/zcode-connector-tools.md` 无变化(B2 通道不走连接器,真人事件走工作空间存储)。
- `docs/zcode-integration.md`、`adapters/README.md` 状态行更新。

## 7. 下一阶段可用输入与未满足退出条件

- **B3(材料载入与对账,G01-Z02)可开工**:连接器工具契约草案已在 `docs/zcode-connector-tools.md` §4.3(zcode_load_material/zcode_lookup_load);核心 drive 状态机与 24k 截断规避设计(内容寻址文件 + hash 确认)待实施。
- **声明翻转待办**:独立验收通过 B2 后,`human_authorization_events` 置 true(一行改动+测试断言更新),生产路径即可用真人事件授权。
- **G-min 对接面已就绪**:GUI 确认按钮只需调 `authorizations.submitHumanEvent`(entry `gui-confirm`),存储与全链已验证。
- **未满足退出条件**:P5-H 原验收链(05H 八步)未跑通;G01 仍 BLOCKED;本增量通过不代表 P5-H 收口。
