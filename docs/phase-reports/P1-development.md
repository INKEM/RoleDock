# P1 开发报告：自定义角色与持久状态

- 阶段：P1（角色与存储）
- 日期：2026-10-12
- 开发 Agent：ZCode（GLM）
- 前置：P0 已通过独立验收（`docs/phase-reports/P0-review.md`，结论 PASS，基线 `2cad492`）
- 状态：**待独立验收**

## 1. 实际基线

| 提交 | 内容 |
| --- | --- |
| `098f346`…`2cad492` | P0 基线（5 个提交，已验收） |
| `5df3075` | P1 实现：角色包加载、SQLite 状态层、单协调器锁、策略与管理入口、示例包、测试 |
| `01c33a7` | 文档更新 + P1 开发报告（首版） |
| （返工提交，见 `P1-rework.md`） | R-1（vitest 超时与文件级串行配置）、R-2（同内容重装恢复丢失内容，`content_repaired` 标志 + 回归测试） |

首次提交版本的 P1 经独立验收为 REWORK（`P1-review.md`，R-1 测试在 CI 等价负载下超时偶发、R-2 同内容重装不恢复丢失内容）；两项已按 `docs/phase-reports/P1-rework.md` 修复并复验（连续 5 轮 `npm run check` 全绿，第 1 轮为 `npm ci` 后立即执行；168/168 测试通过，含 R-2 回归测试）。**以返工后的最新提交为验收基线。**

## 2. 任务完成度与验收条件对照

P1 提示词 7 项任务：

1. ✅ **角色包加载**：`loadRolePack`（`packages/core/src/roles/loader.ts`）——manifest 走 P0 `validateRolePack`（Schema+语义唯一性）；`requires_protocol` 校验；引用文件缺失报错；`realpath` 校验全部引用落在包根内（穿越与符号链接越界拒绝，含符号链接目录）；包内任何符号链接拒绝（含未引用的散落符号链接）；输出 Schema 递归扫描 `$ref`，拒绝 http(s) 远程引用；内容哈希 = SHA-256(排序相对路径+NUL+字节)。
2. ✅ **状态层**：`WorkspaceStore` + 带校验和的编号迁移（迁移 001 建表：workspace、role_packs、roles、role_heads、agent_instances、sessions、documents、document_revisions、idempotency_keys、outbox_events、schema_migrations）；同步事务接口 `tx()`；表结构与接口对 P2–P4 就位（documents/revisions/sessions/instances 本期只建表不写入）。
3. ✅ **单协调器约束**：`PRAGMA locking_mode = EXCLUSIVE` 主连接持有文件锁；第二个 Coordinator（同进程或跨进程）首条语句 SQLITE_BUSY → 结构化 `WORKSPACE_LOCKED`；进程死亡 OS 释放锁、无陈锁。**真实多进程验证**（`tests/integration/workspace-lock.process.test.ts`）：子进程持锁 → 第三个进程探测得到 `WORKSPACE_LOCKED` 信封 → SIGKILL 子进程 → 重新打开成功。
4. ✅ **roles.install/list/resolve**：真实实现（staging 复制 → 事务注册 → 提交后原子提升）；新角色安装后为未初始化（generation 0、无实例）；`resolveRole` 对未初始化角色返回明确 `initialized:false`，对未安装角色返回 `NOT_FOUND`。
5. ✅ **受信身份与能力作用域**：`TrustedIdentity` 类型固定（会话身份由协调器签发，P3 落库；本期无 API 可铸造）；`policy.evaluate` 纯函数只查授权表；**所有者管理入口** `WorkspaceAdmin`（CLI `admin policy/grant/revoke`）与**会话调用入口**（Coordinator）分离；安装绝不把 `requested_capabilities` 写入授权（测试断言 grants 为空、自报身份被拒）。
6. ✅ **存储基础**：document_revisions / idempotency_keys / outbox_events 表与事务边界就位并可测试（事务内写入后回滚 → 无行；提交 → 持久）。外部执行未实现（诚实 `NOT_IMPLEMENTED`）。
7. ✅ **示例包**：`examples/demo-team`（builder/reviewer/explainer，含模板与本地引用的 review-result Schema）、`examples/custom-role`（`archivist`，不同 ID 与职责：accession-log / transfer-checklist）。

P1 验收条件逐项：

| 验收条件 | 证据 |
| --- | --- |
| 两个角色包可安装和查询，重启后状态仍在；冲突版本／角色 ID 返回结构化错误 | `tests/integration/examples-install.test.ts`（安装两个示例包 → 4 角色；close+reopen 后仍在、workspace id 不变）；冲突：同版本异哈希 `IDEMPOTENCY_CONFLICT`、跨包角色 ID `ROLE_ALREADY_EXISTS`（install.test.ts，均断言 details 结构） |
| 权限需求声明不自动变成会话能力 | `policy.test.ts`：安装后 `grants = {}`、`evaluate` 拒绝自报身份；admin grant 后 evaluate 通过；`examples-install.test.ts` 断言 requested ≠ granted |
| 跨工作空间读写、包路径越界和错误迁移被拒绝 | 跨工作空间：workspace_id 不匹配 → `VALIDATION_FAILED`，B 工作空间查不到 A 的角色（`NOT_FOUND`）（examples-install.test.ts）；路径越界：穿越/符号链接文件/符号链接目录三类用例（loader.test.ts）；错误迁移：篡改校验和与未知迁移 id 均被拒（store.test.ts） |
| 事务回滚不留下半安装角色包，状态存储不依赖某业务角色名称 | install.test.ts「mid-install 失败」用例：注入 roles 主键冲突 → 安装抛错 → role_packs 无新行、无 .staging 残留；迁移 SQL 与存储层无任何业务角色名（no-business-roles 扫描覆盖新增源码，167 测试中的逐文件断言） |
| 单协调器约束有真实进程或锁级验证 | `workspace-lock.process.test.ts`（真实子进程 + 跨进程探测 + SIGKILL 恢复），见任务 3 |

## 3. 主要文件与公共接口变化

**`@roledock/core` 新增公共面：**

- `WorkspaceStore.open({root})` / `tx()` / `prepare()` / `getConfig` / `setConfig` / `packsDir` / `close()`；`runMigrations`、`MIGRATIONS`。
- `Coordinator.open({root, workspaceId?})`（新生命周期；旧裸构造移除）；真实实现 `installRolePack` / `listRoles` / `resolveRole`；`close()`；其余 15 操作保持 `NOT_IMPLEMENTED`（测试断言 15 个全部拒绝）。
- `WorkspaceAdmin.open()`：`showPolicy` / `grant` / `revoke`（revoke 未持有的能力 → `NOT_FOUND`；grant 幂等）。
- `loadRolePack`（`LoadedRolePack`：manifest/contentHash/files）；`installRolePack`（`InstallResult`，`reinstalled` 标志）；`evaluate` / `assertCapabilityName`；`TrustedIdentity`；`HandleOptions`。

**`@roledock/cli`：** `roles install <dir>`、`roles list`、`roles resolve <id>`、`admin policy|grant|revoke` 接通真实工作空间；`--root` 语义改为工作空间根（默认当前目录）；其余命令保持 `NOT_IMPLEMENTED`。

**`@roledock/protocol`：** 错误码注册表 13 → **14**（新增 `WORKSPACE_LOCKED`）。

**工作空间磁盘布局：** `<root>/.roledock/{state.sqlite, packs/<name>/<version>/...}`；安装采用 `.staging-<uuid>` → 事务 → 原子改名，失败清理。

## 4. 实际运行的验证与证据

2026-10-12 本机（Ubuntu 22.04.5, Node v22.23.2）实际执行：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（src+tests 全量） |
| `npm test` / `npm run check` | **15 个测试文件、167 个测试全部通过，0 跳过**（返工后为 168，见 `P1-rework.md`；返工后连续 5 轮 check 全绿，第 1 轮为 `npm ci` 后立即执行） |
| 多进程锁（真实子进程） | `workspace-lock.process.test.ts` 通过：持锁期间跨进程探测 `WORKSPACE_LOCKED`、SIGKILL 后恢复 |
| CLI 端到端手工验证 | `roles install examples/demo-team` → 信封 `{ok:true, data:{pack:{name:"demo-team",version:"0.1.0",content_hash:"4751a96…"}}}`；`roles list` / `admin grant builder documents.read` / `admin policy` 全部按预期 |

测试构成（P1 新增 37 个）：store 6（迁移幂等/持久化/回滚/篡改校验和/未知迁移/同进程锁）、loader 9（哈希稳定/缺文件/缺 manifest/符号链接文件/符号链接目录/散落符号链接/远程 ref/穿越/协议版本）、install 8（安装/幂等/哈希冲突/角色冲突/回滚无残留/workspace_id/持久化/无授权写入）、policy 5、coordinator 6（含 15 个未实现操作逐一拒绝）、CLI 9（含实现命令与 15 个未实现命令）、集成 5（示例端到端/幂等/管理员授权/跨工作空间/多进程锁）、既有 conformance 保持通过。

**规范变更（P1 修订，均记录在案）：** ① 错误码注册表新增 `WORKSPACE_LOCKED`（`sdk-operations.md` §8、两个 Schema 枚举、`ERROR_CODES` 同步，一致性测试覆盖）；② `identity-and-permissions.md` §3 固化两个入口（`WorkspaceAdmin` 所有者面 / `Coordinator` 会话面）；③ CLI `--root` 语义确定为工作空间根；④ revoke 未持有能力定义为 `NOT_FOUND`（显式反馈优于静默幂等）。

## 5. 失败、跳过、未验证与外部阻塞项

- **无跳过的测试，无失败遗留。** 开发过程中修复的问题：`coordinatorOperations` 反射触发了属性 getter（改用 descriptor 过滤，并把生命周期方法 `close` 排除出操作面）；多进程锁测试初版依赖 holder 固定存活时长，在满负载下有偶发窗口——已改为"holder 等待 SIGKILL"的无时序设计，并顺带验证崩溃后无陈锁；连续 4 轮 check 复验稳定。
- **未验证：远程 CI**（沿用 P0 待确定项，无远程仓库）。
- **外部阻塞（待用户决策）：** 托管组织/仓库与 npm scope 认领（沿用 P0 记录，`docs/toolchain.md`）。
- **明确不声称：** 会话打开/继承、文档发布与读取记录、交接、请求执行、outbox 外部动作执行均未实现（表结构与事务边界就位，操作全部 `NOT_IMPLEMENTED`）；角色包升级（同角色 ID 的新版本覆盖）走 P3 交接，本期同角色 ID 的新包一律 `ROLE_ALREADY_EXISTS`。

## 6. 下一阶段可用输入与尚未满足的退出条件

**P2 可直接使用：** documents/document_revisions/idempotency_keys/outbox_events 表与事务接口；`role_heads.knowledge_revision`（安装即以 0 起账）；内容哈希工具与示例包的输出 Schema（P2 的发布校验、读取记录、候选更新、交接包、导出可直接在其上实现）；`WorkspaceStore.tx` 是发布原子性的现成边界。

**P1 退出条件核对：** 任意角色可注册 ✅（两个异构示例包零核心改动安装）；版本与权限需求可验证 ✅（哈希/版本记录 + requested/granted 分离并可见）。真实 Harness 访问等 P5 前置项与 P1 无关。

按流程，下一步把 `prompts/REVIEW.md` 交独立验收 Agent 验收 P1（基线以 `git log` 为准，HEAD 为本报告提交）；验收通过前不执行 P2。
