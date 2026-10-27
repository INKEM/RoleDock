# P6-G4 开发报告：会话观察、撤销与恢复

日期：2026-10-28。状态：**待独立验收**。

基线：HEAD `d9743365` + 未提交工作区（G0–G3 的未提交交付延续，与 G3 验收基线一致；本阶段在其上叠加 G4 变更）。前置 **P6-G3 已独立验收 PASS**（`P6-G3-review.md`，2026-10-28；其观察 O1/O2/O3 已纳入本阶段处理，见"对 G3 验收观察的处理"）。

## 1. 交付范围（对照 `prompts/06G4-session-observability.md` 与计划 §12）

| 工作项 | 交付 |
| --- | --- |
| 1. owner 的 binding/attempt/load 分页视图 | `sessions.listBindings/listAttempts/listLoads` 三个 owner 只读投影（core `ExternalSessionAuthority` + service owner 面 + Schema 传输边界校验），展示 generation、前任实例、知识版本、来源授权、实际能力与载入确认 |
| 2. 连接状态与角色有效性分列；撤销与影响预览 | 绑定视图双字段 `state`（存储态）+ `effective_state`（显示层有效性）；GUI 观察块分列"连接"与"角色有效性"；`authorizations.revokePreview` 只读影响预览 + 既有 `authorizations.revoke`；**不提供 owner release**（释放仍由原会话执行，契约词汇表测试锁定） |
| 3. 有界轮询、观察时间和版本 | 所有响应带 `observed_at`；GUI 活动页 2s 有界轮询、`document.hidden` 暂停、恢复立即刷新；渲染层按 workspace_id + observed_at 单调守卫丢弃陈旧/跨工作空间响应；`admin.events` 维持 outbox 诊断语义未动 |
| 4. 重启恢复不加代次；takeover/撤销/到期规则展示 | E2E 实证重启+重登记后绑定 active、generation 不变；takeover 时间线（前任实例、superseded）由 core 测试实证；`cleanup_pending`/`execution_uncertain` 在 revokePreview 与撤销后如实显示；"撤销已生效"与"外部进程已结束"文案分离 |

## 2. 源码变化（本阶段实际改动）

**协议层 `packages/protocol`**
- `src/types.ts`：新增 `SessionBindingView`/`SessionBindingsPage`、`AnchorAttemptView`/`AnchorAttemptsPage`、`AnchorLoadView`/`AnchorLoadsPage`、`RevokePreview`（输出 DTO 字段白名单；无任何凭据形态字段）。
- `schemas/session-bindings.schema.json`、`anchor-attempts.schema.json`、`anchor-loads.schema.json`、`revoke-preview.schema.json`（draft 2020-12，新增）；`schemas/service-control-operation.schema.json` 增加四操作输入分支；`src/validate.ts` 注册四个 Schema 名。

**核心层 `packages/core`**
- `src/sessions/anchor.ts`：新增 `listBindings`/`listAttempts`/`listLoads`（分页 cursor=`created_at|id` base64url，`sweepAuthorizations` 前置，**投影只读**——superseded 显示层比较不写库）与 `revokePreview`（严格只读，失效语义镜像 `invalidateBinding`）；载入确认与接管时写 `anchor_loads.confirmed_at`/`session_bindings.state_changed_at`。
- `src/sessions/authorization.ts`：`invalidateBinding` 写 `state_changed_at`（语义：进入当前状态的时间）。
- `src/store/migrations.ts`：迁移 8 `observability-timestamps`（两列 ADD COLUMN；**不回填**——旧记录如实 NULL，不伪造时间戳）。

**服务层 `packages/service`**
- `src/index.ts`：owner 面注册四操作，照 `authorizations.confirmations` 样板在传输边界 Schema 校验；trusted/session principal 到达即 `PERMISSION_DENIED`。

**桌面 `packages/desktop`**
- `src/shell/shared/contract.ts`：封闭清单新增 `sessions:`（listBindings/listAttempts/listLoads）与 `authorizations:`（revokePreview/revoke）命名空间；重导出 G4 protocol 类型。
- `src/shell/main/workspace-controller.ts`：四个视图代理 + `revokePreview`/`revokeAuthorization`。
- `src/shell/main/ipc.ts`：五条新 handler（assertTrusted + redact + 分页输入共用校验 `pagedListInput`）；无通用 rpc。
- `src/shell/renderer/pages/confirm.ts`：新增"会话观察（代次·载入·撤销）"块（连接/角色有效性分列、代次时间线、锚定尝试、载入记录、`observed_at`）与"撤销影响预览"块（先预览后确认撤销）；uncertain/failed/revoked/expired 各给"下一步"恢复指引；可见性感知轮询。

**测试**
- 新增 `packages/core/test/g4-observability.test.ts`（4 项）、`packages/service/test/g4-observability.test.ts`（3 项）、`packages/desktop/test/e2e-shell/g4.e2e.spec.ts`（1 项全链）；`shell-contract.test.ts` 增 G4 词汇表断言；`store.test.ts` 迁移计数 7→8；`g3.e2e.spec.ts` fixture 路径改 `import.meta.dirname` 锚定（O3）；`shell.e2e.spec.ts` 两处封闭清单断言更新。

## 3. 契约与文档变化

- `docs/spec/desktop-gui-contract.md` **v7**：四操作标"G4 已实现"；§1 形态限制更新；§2.2/§2.3 标注；§4 shell 清单扩展并**补记 G3 `bridgeStatus`（O2 修复）**。
- 无依赖变动（不需更新 toolchain）；无架构/权限变化（四操作即 ADR-0013 决策 3/7 与本契约 §2.3 的既定落点，不需新 ADR）。

## 4. 对 G3 验收观察的处理

- **O1**（真机缺成功态截图）：真机补拍步骤已写入 `evidence/2026-10-27-p6-g4/STEPS.md` 步骤 3/4（gui-03/gui-04），自动化侧以 `automated/gui-01-active-timeline.png` 覆盖同一画面。
- **O2**（§4 漏 bridgeStatus）：已补记（见上）。
- **O3**（E2E fixture 路径依赖 cwd）：`g3.e2e.spec.ts` 与新 `g4.e2e.spec.ts` 均以 `import.meta.dirname` 锚定，从任意 cwd 运行可复现。

## 5. 验证（全部真实运行）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx tsc -b packages/protocol packages/core packages/service packages/desktop`（分步） | 全部通过 | 0 |
| `npx vitest run packages/core/test/g4-observability.test.ts` | 4/4 PASS | 0 |
| `npx vitest run packages/service/test/g4-observability.test.ts` | 3/3 PASS | 0 |
| `npm run check`（build+typecheck+全部测试） | **533/533 PASS（55 文件）** | 0 |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts` | **13/13 PASS**（原 12 项 + g4 全链） | 0 |
| `ROLEDOCK_G4_EVIDENCE_DIR=… npx playwright test … g4.e2e.spec.ts`（证据采集运行） | 1/1 PASS，截图 2 张落盘 | 0 |

失败/返工记录（均已修复并复跑）：① core 测试首轮 3 处失败——分页第二会话误用 initialize（角色已有知识需 takeover）、revoke 后 mock 同步完成回收（cleanup_pending=0 属正确语义，改为 Held 夹具真实覆盖 cleanup_pending=1 + execution_uncertain=1）、baseline 移动在 attempt 落库前抛出（改用 load-incapable 夹具覆盖失败尝试记录）；② E2E 首轮失败——GUI 确认面按 G3 定档**拒绝**对已有存活授权的会话二次确认（`confirm.ts:34` 守卫，行为正确保留），双授权改经 owner 面 `submitHumanEvent` 写入、受信桥推进；③ G1 shell E2E 两处封闭清单断言按新词汇表更新；④ `store.test.ts` 迁移计数更新。

## 6. 证据

`docs/phase-reports/evidence/2026-10-27-p6-g4/`：
- `automated/gui-01-active-timeline.png`：锚定成功后的会话观察块（连接 running、有效性 active、代次时间线、尝试与载入记录、观察时间）。
- `automated/gui-02-revoked-connection-split.png`：撤销后同块——`连接：服务 running` 与 `已撤销（revoked）` 并列显示，时间线含状态变更时间，存活的 8h 第二授权仍可单独预览（撤销其一不影响其记录）。
- `automated/shell-e2e-g4.log`：证据采集运行日志。
- `STEPS.md`：真机补充证据步骤（含 O1 补拍 gui-03/gui-04、双授权、撤销面、重启恢复）+ `collect-state.mjs`（四视图后端状态导出）+ `submit-second-auth.mjs`（双授权写入）。**真机证据待补**，见"遗留与风险"。

## 7. 关键行为定档（实现即定档，验收可对照）

- **投影只读**：三个视图与 revokePreview 均不推进状态；superseded 显示层比较不写库（与 session 面 `binding()` 的写回语义区分，后者维持原行为）。
- **时间戳不伪造**：迁移 8 仅对新写入生效；旧行 `confirmed_at`/`state_changed_at` 为 NULL，GUI 对 NULL 显示"—"。
- **分列不合并**：连接可用性来自 shell `workspace:status` 与登记态；角色有效性来自绑定 `effective_state`。断线显示"这是连接状态，不是授权撤销"；revoked 文案明确"撤销已在 RoleDock 生效；外部会话进程是否结束以宿主为准"。
- **双授权**：GUI 确认面在已有存活授权时拒绝二次确认（G3 定档守卫保留）；并存授权经 owner 面/CLI 写入产生；撤销其一仅使以其 `authorization_id` 激活的绑定失效，另一条授权记录不动（E2E 实证 `authorizations.get` 撤销后剩 1 条）。
- **restart 不加代次**：重登记幂等返回同一 ext、绑定 active、generation 1 不变（E2E 实证）；重登记刷新 `mcp-session.env`（0600）后新 MCP 进程立即可用。
- **词汇表封闭**：`sessions:`/`authorizations:` 仅含五个方法，无 release（契约测试 + shell E2E 双重锁定）。

## 8. 遗留与风险

1. **真机证据待补**（唯一阻塞项性质为"材料未采集"，非功能缺口）：STEPS.md 步骤 1–8 需在真实 ZCode 桌面会话执行，产出 gui-03…gui-07 与 `backend-state-real.json`。自动化证据已覆盖同版本代码的相同代码路径。
2. takeover 后旧实例 superseded 的 **GUI 实景显示**：core 测试已断言 `effective_state="superseded"`+前任实例；GUI 渲染与其他状态共用同一 VALIDITY_TEXT 路径。mock 服务 bin 只有一个可登记 fixture 会话（桥主体绑定），E2E 无法产生第二可登记会话——真机步骤 7 覆盖。
3. `authorizations.confirmations` 的 `limit` 上限 200 与本阶段 GUI 取数（limit 200）一致；超长历史分页 UI（翻页控件）未做，当前全量单页渲染，条目规模为登记会话数级别。
4. 知识漂移 REVISION_CONFLICT 的真机复现仍未触发（G3 遗留沿用）；uncertain→reconcile 的恢复指引已入 GUI 文案。

## 9. 退出条件自查（计划 §12）

- 用户无需查看 SQLite 即可从 GUI 解释：某会话现在是否有权工作（连接/有效性分列）、为何失败（attempt 错误消息层）、应回哪一会话恢复（各状态"下一步"指引）——自动化 E2E 断言覆盖。
- 状态数据带观察时间与分页（`observed_at` + cursor 分页，服务端测试覆盖）。
- 撤权生效与外部回收确认分开显示（E2E 步骤 7）。
- 不做聊天历史查看器（未做）；`admin.events` 未升级（未动）。

## 10. 停止点

本阶段完成即停止：不进入 G5、不 commit、不远程发布。交独立验收 Agent 按 `prompts/REVIEW.md` 形成 `P6-G4-review.md`。
