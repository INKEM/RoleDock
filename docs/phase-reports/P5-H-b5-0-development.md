# P5-H-b5-0 开发报告:契约预留(ADR-0012 落档 + 受管执行语义 + `--sandbox` 参数面)

日期:2026-10-24;状态:**待独立验收**。

按 [ADR-0012](../adr/0012-adapter-enforced-isolation.md) 与 [ADAPTER_SANDBOX_PLAN](../ADAPTER_SANDBOX_PLAN.md) 执行 P5-H 增量 B5 系列的第一增量 B5-0(契约预留)。本增量只新增契约语义与参数面,**不实现沙箱 runner、不翻转任何隔离声明、不改动 B0–B4/G-min 已验收行为路径**;沙箱实现与逃逸证据属 B5-1/B5-2,请求链受管接线属 B5-3,声明翻转与收口属 B5-4。

## 1. 实际基线

- 开发起点 HEAD:`a083874e60e7a40d88a18e075b699b1fb818b0e1`(同一工作区,含 B0–B4/G-min 未提交改动;`evidence/2026-10-24-p5-h-b5-0/baseline-head.txt`)。
- 官方 CLI 入口与工具链不变;无新依赖(连接器仅新增自身 CLI 参数)。

## 2. 交付与验收条件对应

| 计划项(ADAPTER_SANDBOX_PLAN §3 B5-0) | 交付 |
| --- | --- |
| ADR-0012 落档 | `docs/adr/0012-adapter-enforced-isolation.md` 已随工作区就位(状态"已接受",实施随 B5 系列)。本增量未改动该 ADR。 |
| `adapter-contract.md` 增加"受管执行与隔离证据"语义 | §2 能力等级补语义修订指针("保证"= 适配器保证,验收标准是逃逸测试证据);文末新增 "P5-H 增量 B5:受管执行与隔离证据(ADR-0012,2026-10-24)" 节:语义变更、证据标准、受管执行范围(仅咨询分支)、效果层强制、失败关闭、声明与证据分离、既有路径复用与 `capability_scope`/`temp_dir` 的 B5-3 解锁预告。 |
| `zcode-connector-tools.md` §4.5 受管执行草案 | 新增 §4.5(标注"草案,B5-1 交付实现"):`--sandbox` 参数语义、沙箱 spawn 参数草案表(runner / 可写临时目录 tmpfs ↔ `temp_dir` / 材料目录只读挂入 / 出口白名单 provider 端点 / pid+cgroup 全进程树 / 凭据留边界外)、runner 探测语义(缺失/启动失败/中途消亡 → NOT_IMPLEMENTED 或 uncertain)。 |
| 阶段门文档登记 | AGENTS.md 方向段(ADR-0012 + B5-0→B5-4 续作链)、DESKTOP_GUI_PLAN §8 B5 行、prompts/README.md 续作表 B5 行均已随工作区就位;本增量核对一致,未再改动。 |
| 连接器 `--sandbox` 参数预留(默认关闭) | 已实现并真实取证(见 §4):默认关闭 = 既有行为零变化;B5-0 阶段启用即启动前抛 `NOT_IMPLEMENTED` 错误信封、退出码 1(失败关闭,不静默忽略、不无沙箱降级)。 |

退出条件逐项:

1. **文档与契约齐备**:上表前四项均已在案(§3/§6 文件清单)。
2. **全量门禁绿**:`npm run check`(typecheck → test)通过,40 文件 / 419 测试全部通过(`evidence/2026-10-24-p5-h-b5-0/full-check.log`)。
3. **四项声明不变**:`adapters/zcode/src/index.ts` getCapabilities 保持 `isolation: { context:false, temp_writes:false, results:false, capability_scope:false }` 与 `level:"restricted"`;`capability_scope`/`temp_dir` 的 NOT_IMPLEMENTED 拒绝原样保留(B5-3 才在受管路径解锁)。

## 3. 主要文件与公共接口变化

- `adapters/zcode/src/reference-bin.ts`:parseArgs 新增 `--sandbox`(boolean,默认 false)并传入 `runReferenceConnector`。
- `adapters/zcode/src/reference-connector.ts`:新增导出 `ReferenceConnectorOptions` 接口(`sandbox?: boolean`);`createReferenceConnectorServer` 入口处 `sandbox === true` 抛 `RoleDockError("NOT_IMPLEMENTED", …)`(失败关闭,在建立任何连接或 spawn 任何子进程之前)。不递增 `REFERENCE_CONNECTOR_VERSION`(0.3.0):契约 §2 要求工具集变更时递增,本增量未增删任何工具。
- `adapters/zcode/test/reference-connector.process.test.ts`:新增真实进程用例 `refuses --sandbox (fail-closed) until B5-1 delivers the sandbox runner`——实跑连接器二进制,断言非零退出且 stderr 含 `{"ok":false,"error":{"code":"NOT_IMPLEMENTED"}}` 信封(对 stderr 全部行扫描提取:连接器加载 `node:sqlite` 时 Node 实验特性警告的落盘顺序不可靠,首版"取最后一行"断言不稳定,已修正)。适配器既有 3 用例覆盖默认关闭路径。
- 文档:`docs/spec/adapter-contract.md`(§2 指针 + 文末 B5 节)、`docs/zcode-connector-tools.md`(§4.5)。无新依赖;工具链不变。
- 主 CLI 与 `ZCodeAdapter` 不动:probe bin 既有 `--connector-arg` 透传已可把 `--sandbox` 传给连接器并得到同一失败关闭行为。

## 4. 实际运行与证据(`docs/phase-reports/evidence/2026-10-24-p5-h-b5-0/`)

- `sandbox-refusal.log`:实跑 `node adapters/zcode/dist/reference-bin.js --sandbox --cli /nonexistent-cli.mjs` → stderr 输出 `{"ok":false,"error":{"code":"NOT_IMPLEMENTED","message":"Managed sandbox execution is reserved (B5-0) and NOT_IMPLEMENTED until B5-1 delivers the sandbox runner; refusing to start without the sandbox boundary (fail-closed).","retryable":false}}`,进程退出码 1。
- `full-check.log`:最终全量 `npm run check` 完整输出,40 文件 / 419 测试全部通过,exit 0。
- 预留行为测试:`adapters/zcode/test/reference-connector.process.test.ts` 新用例通过(单跑 3/3,全量 419/419)。

## 5. 失败、边界与未验证项

1. **开发中修复**:预留测试首版断言 stderr 最后一行为 JSON 信封,被 Node 的 SQLite 实验特性警告干扰(警告行与信封行落盘顺序不可靠)——改为全行扫描提取信封;`sandbox-refusal.log` 中可见同一现象(信封行在警告行之前)。
2. **如实边界**:`--sandbox` 在 B5-0 只是参数面预留,没有任何沙箱行为;启用即拒绝是本增量的全部语义。不因参数存在而宣称"已支持受管执行"。
3. **未验证/未交付**:沙箱 runner 选型与真实沙箱内模型轮(B5-1);逃逸测试矩阵(B5-2);requests executor 受管接线与 05H 步骤 7–8 复验(B5-3);隔离声明翻转(B5-4)。conformance 套件仍未纳入 zcode(受管变体接入随 B5-3 决定,ADAPTER_SANDBOX_PLAN §5)。
4. **声明现状**:四项隔离全 false;`external` 声明(load_materials/reconcile_load/cancel 等)与 B4 验收状态一致,未动。

## 6. 规范与 ADR 更新

- 无新架构决策(ADR-0012 框架内续作);本增量把 ADR-0012 的语义落进两份契约文档(见 §2/§3)。
- `docs/ADAPTER_SANDBOX_PLAN.md`、`docs/adr/0012`、AGENTS.md、DESKTOP_GUI_PLAN §8、prompts/README.md 的 B5 登记在决策时已就位,本增量核对一致。

## 7. 下一增量可用输入与未满足退出条件

- **B5-1(沙箱执行器技术验证)输入**:§4.5 的 runner 探测语义与 spawn 参数草案;连接器 `--sandbox` 入口已接线(当前拒绝);B5-1 需交付 runner 选型定档(`docs/toolchain.md` 版本精确固定)、受管模式最小真实链(沙箱内 app-server 裸会话 → 1 真实模型轮 → 出口白名单 → helper RPC 凭据注入 → 进程树回收)、runner 缺失路径 NOT_IMPLEMENTED、并发 2–3 实例烟测。
- **未满足的收口条件**:G01-Z03 仍 BLOCKED、四项隔离声明仍 false、05H 步骤 7–8 仍按设计拒绝——均待 B5-2/B5-3 证据与独立验收;本增量通过不构成任何隔离证明。
