# P1 返工报告

- 阶段：P1（角色与存储）返工
- 日期：2026-10-12
- 开发 Agent：ZCode（GLM）
- 依据：`docs/phase-reports/P1-review.md`（结论 REWORK，返工项 R-1、R-2）
- 状态：**已修复，待复验**（正式结论由验收 Agent 复验后给出）

## 复现基线

返工前基线：`01c33a7`（P1 开发报告提交）。两项问题均在本地复现：

- **R-1 复现**：`npm ci` 后立即执行 `npm run check` → **7 个测试超时失败**（160/167 通过，无断言失败；失败集中在涉及 `WorkspaceStore.open` 的测试，vitest 默认 5s/10s 超时被 fsync 主导的打开/事务路径击穿，与验收报告的机制判断一致）。
- **R-2 复现**：安装 → 删除 `packs/<name>/<version>/` 内容目录 → 同内容重装 → 返回 `reinstalled: true` 而 `content restored: false`（行与内容漂移，与 install.ts 内注释声明矛盾）。

## R-1：测试套件在 CI 等价负载下超时偶发（P1 优先级）

**修改**（`vitest.config.ts`，不删除断言、不缩短验证）：

- `testTimeout: 30000`、`hookTimeout: 30000`——与 SQLite fsync 主导的操作成本（验收实测：open 256–598ms、单事务最高约 200ms、满负载下更慢）匹配的预算；
- `fileParallelism: false`——测试文件串行执行，消除 EXCLUSIVE 锁/子进程密集套件在并行 worker 下的磁盘争用（这正是 `npm ci` 后冷缓存场景的放大器）。

**验证结果**：

| 轮次 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `npm ci` → 立即 `npm run check` | **168/168 全绿** |
| 2–5 | 连续 `npm run check` | 168/168 全绿 ×4 |

连续 5 轮全绿，第 1 轮即 CI 执行序列（`npm ci` → `check`），满足复验要求。真实 CI 运行记录仍无法提供（无远程仓库，沿用待确定项 O-2）；本轮修复直接针对验收报告指出的负载形态。

## R-2：同内容重装不恢复丢失的包内容（P2 优先级）

**修改**（`packages/core/src/roles/install.ts`）：

- 同哈希早退路径在返回前校验已存储内容目录的存在性（以 `rolepack.json` 为标记）；缺失时从已验证的源包执行一次 staging→提升修复，返回值新增 `content_repaired: true`（存在时为 `false`，`InstallResult` 接口相应扩展）；
- staging 复制与原子提升提取为 `copyToStaging` / `promoteStaging` 两个助手，主安装路径保持原顺序（复制 → 事务 → 提升），修复路径复用同一提升逻辑；
- 原"由幂等重装修复"的不实注释删除，替换为对一致性行为的准确描述。

**回归测试**（`packages/core/test/install.test.ts`）："repairs lost pack content on identical reinstall (R-2 regression)"——安装 → 删除内容目录 → 重装，断言 `reinstalled: true`、`content_repaired: true`、内容文件树完整恢复、角色行数不变。既有幂等测试补充 `content_repaired: false` 断言。

**验证结果**：

- 新回归测试通过（全套 168/168）；
- 按验收复验方法重复"内容丢失重装"实验（走构建产物 `packages/core/dist`，非测试代码）：**`content restored: true`**，`reinstalled: true`、`content_repaired: true`。

## 受影响的回归与无关范围

- 全量 `npm run check`（typecheck + 168 测试）5 轮全绿；P0 基线提交无改动，P0 结论延续。
- 除上述两个文件（`vitest.config.ts`、`roles/install.ts`）及其测试外，无其他行为改动；15 个未实现操作、权限模型、单协调器锁、迁移与隔离语义均未触碰。

## 剩余事项

- 真实 CI 运行记录与托管位置：待用户决策（P0/P1 验收共同记录的 O-2），不阻塞本阶段复验。
- 非阻塞观察项 O-1（no-business-roles 名单范围）按验收意见维持现状，归属后续阶段。

## 供复核的变更与命令

```bash
git diff 01c33a7..HEAD -- vitest.config.ts packages/core/src/roles/install.ts packages/core/test/install.test.ts
npm ci && npm run check        # CI 执行序列，第 1 轮复验条件
npm run check                  # 连续 ≥4 轮
npx vitest run packages/core/test/install.test.ts   # R-2 回归测试
```

变更未合并、未发布；P1 是否通过由验收 Agent 复验 R-1、R-2 后宣告。
