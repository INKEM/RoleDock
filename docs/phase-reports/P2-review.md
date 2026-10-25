# P2 当前工作区复验（2026-10-13）

本轮结论：**REWORK**。基线为 `a083874e60e7a40d88a18e075b699b1fb818b0e1` + 当前 P5 未提交实现；现有 279 项测试全通过，但专项反例改变了受影响阶段的结论。

返工／缺口：R02–R06（实际策略、公开捷径／回执、编辑基线、导入路径、摘要知识修订）。

逐项验收条件、问题优先级、触发方式、位置、影响、修复和复验方法统一见 [P0–P5 复验报告](P0-P5-revalidation.md)。本轮只改验收与计划材料，保留产品实现。新 GUI 要求另见 [桌面实施计划](../DESKTOP_GUI_PLAN.md)，不追溯作为旧阶段缺陷。

---

> 以下为此前验收报告原文，保留历史证据。其结论仅对应当时验收范围；当前继续开发门槛以上面的本轮结论为准。

# P2 独立验收报告：版本文档与可迁移知识

- 阶段：P2（文档与知识）
- 日期：2026-10-13
- 验收 Agent：ZCode（GLM，独立验收）
- 验收依据：`prompts/REVIEW.md`、`prompts/02-documents-and-knowledge.md`、`prompts/COMMON.md`、`docs/DEVELOPMENT_PLAN.md`、`AGENTS.md`、`docs/phase-reports/P1-review.md`
- 被验收报告：`docs/phase-reports/P2-development.md`

## 结论：**PASS**

P2 全部五项验收条件均满足且有真实、可复现的证据；实现质量、权限边界与夹具约束核查全部通过；未发现需要返工的问题。

## 1. 验收基线

| 项 | 值 |
| --- | --- |
| HEAD | `b58fc04`（docs(p2): P2 development report） |
| 提交序列 | P1 验收基线 `b4ceeae` + `f2b2dd4`（P2 实现）+ `b58fc04`（报告），与开发报告 §1 一致 |
| 工作树 | 干净 |
| 范围核查 | P2 提交对 `P1-review.md` 的改动即验收 Agent 复验后的 §7 内容原样入库，验收文本未被改动 |

## 2. 独立执行的验证与结果

| 验证 | 结果 |
| --- | --- |
| `npm ci` → 立即 `npm run check`（CI 等价序列） | **全绿：19 个测试文件、212 个测试全部通过，0 跳过** |
| `npm run check` 第 2、3 轮 | 全绿 ×2（212/212），与开发报告一致 |
| 业务角色名独立 grep（`packages/*/src` + schemas，含 P2 新增 6 个模块） | 零命中 |
| 跳过/聚焦测试扫描（`.skip`/`.todo`/`.only`/`xit`/`fit`） | 零命中 |
| 未实现操作诚实性 | 9 个操作（sessions ×2、handoffs ×2、requests ×4、artifacts ×1）保持 `NOT_IMPLEMENTED`，测试动态枚举断言 |
| CLI+SDK 端到端手工验证（全新临时工作空间，SDK 夹具建会话 → CLI/SDK 混合驱动） | 见 §3 各条 |

## 3. 验收条件逐项核验（含手工复现）

### 条件 1：文档历史可读；过期发布、非所有者发布和旧代次发布均失败 — ✅

- 历史：v1/v2 连续发布后旧修订可读且内容哈希不变（内容寻址区 `<root>/.roledock/objects/<hash[:2]>/<hash>`，读取时重算哈希校验，损坏报 `INTERNAL`）。
- 过期发布：同基线第二次发布 → `REVISION_CONFLICT`，details 带当前修订（CLI 实测退出码 1、`current_revision: 1`）。
- 非所有者：**所有者取自会话绑定而非输入**，reader 会话发布 writer 的文档 → `VALIDATION_FAILED`（键未为其角色声明）；未声明键同理被拒。
- 旧代次：夹具升代后旧会话发布 → `INVALID_STATE_TRANSITION`（手工复现：generation 1→2 后旧会话发布被拒）。

### 条件 2：并发发布保留一个成功版本，另一项冲突不丢失候选内容 — ✅

- 同基线双发布一胜一 `REVISION_CONFLICT`；败者内容经 `documents.propose` 保留为 open 候选（baseline 与内容断言，测试验证）。
- 候选采纳在发布时**再次校验 baseline**：过期采纳 `REVISION_CONFLICT` 且候选保持 open（手工复现：导入候选对空目标采纳冲突、候选保留；所有者发布追平基线后采纳成功，正文逐字保留为 `"round trip body"`）。

### 条件 3：每次相关知识发布均更新 knowledge_revision，快照引用确切文档版本 — ✅

- 发布与 `knowledge_revision` 递增同事务（CLI 实测：首次发布返回 `knowledge_revision: 1`；测试断言逐次递增）。
- `buildCheckpoint` 只快照**已持久化**修订的确切 revision+content_hash（手工复现：快照哈希与 CLI 发布返回的 `be984599…` 完全一致）；未发布内容绝不进入快照（测试覆盖）；捕获构建时点 generation/knowledge_revision，非陈旧视图；结果过 protocol `checkpoint` Schema 校验后落库。

### 条件 4：读取回执不能跨身份冒用；候选导入必须校验导出基线 — ✅

- 回执由 `documents.read` 路径产生并**重读会话行**绑定真实会话/实例/读者角色/修订/哈希/时间（手工复现：builder 与 explainer 各自的回执各归其会话）；无任意会话写入面，伪造未知会话 → `VALIDATION_FAILED`；reader 的读取不给 writer 会话留下任何回执。
- 导入候选 baseline = 导出修订；采纳时 `candidate.baseline_revision !== latest` → `REVISION_CONFLICT` 且候选内容保留（测试 + 手工复现一致）。

### 条件 5：导出／导入往返保持哈希与来源，私人材料不会进入默认分享包 — ✅

- 往返：share 导出 → 第二工作空间（模拟另一适配器）导入 → 候选 `proposed_body_hash` 等于原文 SHA-256（测试 + 手工复现正文逐字一致）；manifest 经 `knowledge-export` Schema 校验。
- 过滤：share 范围只含 public/project、永不含 checkpoints（workspace 全量导出为所有者本地）；写出时重算哈希；**手改包夹带 private 条目与未知角色条目均被跳过并报告**（测试构造走私场景验证）；篡改 bundle 任一文件 → 全量哈希校验先于任何数据库写入，`VALIDATION_FAILED` 且目标库零改动（手工复现：候选数为 0）。

## 4. 专项与约束检查

- **夹具不构成公开权限绕过**：`@roledock/core/testing` 是阶段提示词明确允许的内部测试夹具；经模块私有 WeakMap 注册表访问 store，`Coordinator` 操作面、原型属性与 `IMPLEMENTED_OPERATIONS` 均无 testing 入口（测试断言），CLI 命令表不含夹具且**不铸造会话**（`--session` 需既有会话 id，缺省报结构化错误）。代次直升捷径仅存在于夹具路径，P3 生产路径（sessions.open + 交接校验）将取代——边界在 AGENTS.md 与规范中明文记录。
- **四级可见性与咨询分支限制**：`canRead` 矩阵实现与规范 §5 一致；同角色 `kind='request'` 分支只读 project/public，相同 role_id 不解锁 role/private（测试覆盖）。
- **P0 硬约束延续**：核心无业务角色（grep + conformance 持续通过）；声明≠授权未回退（发布权来自绑定+主实例+代次+修订四重校验，与 grants 解耦）；未实现功能不伪装（9 操作诚实失败）；无跳过测试；Mock 夹具未被写成真实证据。
- **迁移 002**：`document_revisions` 因 visibility CHECK 扩展按 SQLite 惯例重建回填；既有篡改校验和/未知迁移防护测试继续通过。
- **规范同步**：§5 四级表+咨询分支限制、§5a 回执与候选生命周期、§5b 导出导入规则与实现一致；`candidate-update`/`knowledge-export` Schema 入协议并过校验测试（13 个新 Schema 用例）。

## 5. 问题清单

无返工项。非阻塞观察项（供后续阶段参考，不构成本阶段缺陷）：

| 编号 | 优先级 | 说明 |
| --- | --- | --- |
| O-1 | P3 | no-business-roles 扫描名单范围（P0/P1 延续，结构性保证仍由 Schema 无枚举 + 逐文件扫描承担）。 |
| O-2 | P3 | 远程 CI 与托管位置待用户决策（P0 起延续）；本阶段 CI 等价序列首轮即全绿。 |
| O-3 | P3 | 导入候选的 `proposed_by_session_id` 使用合成标识 `import-<workspace_id>`（非真实会话）。作为来源记录无害且有意为之，P4 若将回执/候选与真实会话强关联，需明确该字段的语义。 |

## 6. 下一步

1. **P2 通过**，按流程可进入 P3（会话继承）。P3 可直接使用：sessions 表与受信身份解析、checkpoints 表与 `buildCheckpoint`、agent_instances 退休标记、BootstrapBundle Schema——开发报告 §6 的交接清单与实际代码相符。
2. P3 的 `sessions.open` 应以真实 prepare/activate 交接校验取代夹具的代次直升，并保持夹具不可从产品面到达的现有约束。
3. 本验收流程不授予代码合并或远程发布权限。
