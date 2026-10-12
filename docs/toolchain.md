# 环境基线（P0 固定）

日期：2026-10-12
原则：所有工具链版本经实际环境与官方资料核查后**精确固定**（不用浮动 latest），锁文件（package-lock.json）入库。变更须修订本文件并在 P0 报告记录理由。

## 已固定的版本

| 组件 | 版本 | 固定方式 | 核查依据 |
| --- | --- | --- | --- |
| Node.js | 22.23.2 | `.nvmrc` + 根 `engines.node`（`.npmrc` 开启 `engine-strict=true`） | 本机 nvm 唯一已装版本；22.x 为现行 LTS |
| npm | 10.9.8 | `engines.npm >= 10.9.8` | 随 Node 22.23.2 附带 |
| TypeScript | 5.9.3 | 根 devDependencies 精确版本 | `npm view typescript@5 version` 的 5.x 最新（7.x 原生线不采用，保持稳定线） |
| vitest | 5.0.4 | 根 devDependencies 精确版本 | `npm view vitest version`（registry 最新稳定） |
| ajv | 8.20.0 | `@roledock/protocol` dependencies 精确版本 | 原生支持 JSON Schema draft 2020-12 |
| ajv-formats | 3.0.1 | `@roledock/protocol` dependencies 精确版本 | ajv 8 官方格式校验插件（date-time 等） |
| @types/node | 22.20.5 | 根 devDependencies 精确版本 | 与 Node 22 对应的类型线 |
| SQLite | Node 内置 `node:sqlite` | 无第三方依赖，随 Node 版本固定 | 见下节冒烟验证 |
| git | 2.34.1 | （本机环境记录，不强制） | 提交与基线管理 |

## SQLite 选型说明

选择 Node 22 内置 `node:sqlite` 而非 better-sqlite3：

- 零原生依赖：无需 node-gyp/预编译二进制下载，干净检出即可安装，符合"独立开源、干净环境可复现"目标。
- 官方文档（Node v22 API，`node:sqlite`）：22.13.0 起不再需要 `--experimental-sqlite` 标志；稳定性索引 **1.1（Active development）**。配合精确固定的 Node 22.23.2，API 行为可复现；实验状态已在此声明，P1 落库实现时如有 API 变更，在此记录并评估回退 better-sqlite3。
- 覆盖原型需要：同步 `DatabaseSync`（`exec`/`prepare`/事务）满足单协调器（ADR-0001）的存储需求。

### 冒烟验证记录（2026-10-12，Node 22.23.2）

```text
$ node -e "…DatabaseSync(':memory:')…"
select: [{"id":1,"v":"hello"}]
after rollback: {"n":1}
(node:…) ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

验证内容：内存库建表（STRICT）、预编译插入、查询、显式事务回滚。结果符合官方文档行为；实验警告符合稳定性 1.1 的预期。

### 锁行为验证（P1，2026-10-12）

单协调器约束（ADR-0001）采用 `PRAGMA locking_mode = EXCLUSIVE` 的主连接持有文件锁：

- 同进程第二连接：打开成功（SQLite 延迟加锁），首条语句抛 `errcode: 5`（SQLITE_BUSY）→ 映射为 `WORKSPACE_LOCKED`。
- 跨进程：持锁进程存活期间，另一进程首条语句同样 `errcode: 5`；进程退出（含 SIGKILL）后 OS 立即释放文件锁，重新打开成功，无陈锁。
- 以上行为由 `tests/integration/workspace-lock.process.test.ts` 以真实子进程持续验证。

## 网络与注册表

- npm registry `https://registry.npmjs.org/` 可达，`npm view` 查询正常（TypeScript/vitest/ajv/@types/node 均现场核查）。
- 本机无 `.npmrc` 镜像/代理配置；仓库 `.npmrc` 仅含 `engine-strict=true`。

## 命名核查记录（P0 任务 1）

| 名称 | 状态 | 证据（2026-10-12 查询） |
| --- | --- | --- |
| npm 包 `roledock` | 未占用 | `registry.npmjs.org/roledock` → 404 |
| npm scope `@roledock` | 未占用 | registry 与 npmjs 站点均 404 |
| npm 包 `roledock-core` | 未占用 | registry 404 |
| GitHub 仓库 `roledock` | 无同名仓库 | 全站 `roledock in:name` 仅 2 个模糊匹配 |
| GitHub 组织 `github.com/roledock` | **已被第三方占用** | 空组织（仅一个空仓库 `app`），无法注册同名组织 |

结论：npm 侧名称可用；GitHub 组织名不可用为**待确定项**（正式发布前需要用户确定托管组织/仓库位置），本轮不创建任何远程仓库。

## 复现命令

```bash
nvm use            # 读取 .nvmrc → 22.23.2
npm ci             # 按 package-lock.json 精确安装
npm run check      # typecheck（tsc -b --force + 全量 noEmit 检查）→ build → test
```
