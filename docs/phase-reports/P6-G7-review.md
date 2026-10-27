# P6-G7 独立验收报告：桌面全链、可靠性与安装包

日期：2026-10-28。结论：**REWORK**（一项返工项 R1，高优先级——`.deb` 交付物的 `/usr/bin/roledock-desktop` 启动器符号链接指向构建机个人源码树绝对路径，安装后悬空且把 `/home/inkem/...` 仓库路径打进产物，直接违反本阶段"载荷不含仓库源码路径"的核心要求；12 项布局断言对该属性存在盲区。其余验收条件全部满足。R1 为十余行级修复，修复后按 §5 复验打包/冒烟两项即可，不必重验本报告已 PASS 的门禁、E2E、性能与矩阵行为范围）。

依据：AGENTS.md（硬性约束）、prompts/REVIEW.md、prompts/COMMON.md、prompts/06G7-release-validation.md、[P6-G7-development.md](P6-G7-development.md)（完成声明仅作线索，不作结论）、[P6-G7-plan.md](P6-G7-plan.md)（无人值守边界裁定：真机项按材料待采处理）、[P6-G-total-matrix.md](P6-G-total-matrix.md)、desktop-gui-contract §8、DESKTOP_GUI_PLAN §15–17、前序 [P6-G6-review.md](P6-G6-review.md)（R1 已修复复验）与 [P6-G6-rework.md](P6-G6-rework.md)、G4 验收"材料待采不阻塞代码路径验收"先例（P6-G4-review.md §6）。本轮止于验收：未修改产品实现、契约或开发报告，未做任何 commit/合并/发布。

## 1. 验收基线

- HEAD：`323506d`（main；`a17de6c`（G6-R1 收口）之上叠加 G7 单提交），提交时间 2026-10-28 05:12。
- 工作区：验收开始与结束时**均干净**（`git status --porcelain` 零行）；`dist-desktop/`、`dist-app-shell/`、`.cache/` 为 gitignore 构建产物，本轮全部重跑刷新；`docs/phase-reports/evidence/` 未被翻动，无需还原。
- G7 提交范围核对（`git diff --stat a17de6c..HEAD`）：16 个文件——3 个新脚本（pack-deb/packaged-g7-evidence/perf-baseline）、`electron-builder.deb.yml`（新，见 R2）、package.json 两个 npm script、`core/src/testing.ts` 导出 `coordinatorStore`（仅测试夹具入口的导出增加，无产品行为变化）、AGENTS.md 进度行与 docs/evidence。**"无产品 src 变化、无契约变化"的声明属实**。

## 2. 独立运行的验证命令与退出码

| 命令 | 独立结果 | 退出码 |
| --- | --- | --- |
| `nvm use` + `node --version` | v22.23.2（engine-strict 生效） | 0 |
| `npm run check` | **553/553 PASS（59 文件）** | 0 |
| `npx playwright test --config packages/desktop/playwright.shell.config.ts`（仓库根，先 `desktop:build:shell` 刷新产物） | **15/15 PASS（1.2m）**：shell×6 + G2×5 + G3×1 + G4×1 + G5×1 + G6×1，真实 Electron + 真实 service + 真实 MCP stdio，无跳过 | 0 |
| `npm run desktop:pack:deb` | .deb 129,497,850 字节，**12/12 布局断言 PASS**（结果与开发侧证据一致，字节数差 964 为 asar 头时间戳，见 O-5） | 0 |
| `node packages/desktop/scripts/packaged-g7-evidence.mjs /tmp/g7-review-packaged-evidence.json`（`env -u NODE_PATH -u NODE_OPTIONS`） | 打包冒烟 **6/6 PASS**，active binding generation 1（builder），截图与开发侧证据同构 | 0 |
| `node packages/desktop/scripts/perf-baseline.mjs /tmp/g7-review-perf.json` | 造数集 50/200/1000/1000，六视图 p95 3.38/4.43/0.08/1.25/0.02/3.63 ms，启动 238ms，RSS 137MB——与开发侧数字同量级，可复现 | 0 |
| 验收方独立探查：`@electron/asar list`、`ar x` + 解包 `data.tar.zst`、`dpkg-deb -c/--info`、运行期 `ps` 快照 | 发现 **R1**（见 §5）；其余清白 | — |

抽查开发侧证据 `docs/phase-reports/evidence/2026-10-28-p6-g7/`：`pack-deb-result.json`（12 断言）、`packaged-g7-evidence.json/png`（6 检查，绑定 builder@代次 1，事件链/锚定尝试/载入记录齐全）、`perf-baseline.json`（含 "in-process coordinator with the mock adapter; NO model turns" 与 "REFERENCE ONLY — make no capacity claim" 限定语）、`STEPS.md`（A–D 四组真机清单）。截图核对：fixture 宿主诚实标注 "idle / fixture"，会话观察块按"连接状态/角色有效性"分列，撤销预览区与 0600 凭据路径可见。开发报告 §4 的失败/返工记录（electron-builder 下载代理不可用、冒烟脚本三处语法/谓词修复）如实披露，未发现隐瞒。

## 3. 逐条验收条件核对（06G7 五项工作 → 实际代码/脚本/测试）

| 提示词工作项 | 核对结果 | 关键位置/证据 |
| --- | --- | --- |
| 1. 首发安装格式与运行时资源布局；无仓库 node_modules 可运行；不打包账户/helper/测试目录 | **PASS（R1 涉及其入口符号链接，见 §5）**。`pack-deb.mjs` 从 SHA 定位的 electron 44.9.3 缓存 dist + esbuild 产物 + `@electron/asar` 组装载荷，`dpkg-deb --build --root-owner-group` 组包（root 属主确认）；载荷 = /opt/RoleDock（electron dist + app.asar + resources/runtime/{node 22.23.2, vendor 三 bundle, schemas}）+ /usr/share/applications 入口。**验收方独立自查**：asar 清单 57 项，零 node_modules、零 `/home/`/`/Personal/`/`.zcode`/测试目录；`dpkg-deb -c` 全清单仅 electron dist 文件 + app.asar + runtime 三目录 + 入口 + control；control 元数据（Package/Version/Architecture/Maintainer/Description）正确 | `packages/desktop/scripts/pack-deb.mjs`、`pack-deb-result.json`、验收方 `/tmp/g7-asar-list.txt`、`/tmp/g7-deb-extract/` |
| 2. GUI-01–14 逐条执行 | **PASS（自动化可达部分）**。总体矩阵 14 项逐项核对到真实测试/脚本：GUI-01/14→pack-deb 断言+打包冒烟；GUI-02→shell.e2e 六用例（两窗口一 writer、关窗服务存活、退出回收 owned、附着不抢锁、并发首开单结果、未授权 IPC 拒绝）；GUI-03→g2 E2E（custom-role 安装、requested vs grants 分列、launcher 分支 gated+诚实 restricted）；GUI-04→mock 全链（G3/G4/G7 冒烟，fixture/真实宿主分列）；GUI-05→g4 E2E（连接/有效性分列、superseded/revoked 展示、时间线）；GUI-06→core g4-observability takeover 前任时间线 + anchor.test 恢复不加代次；GUI-07→g5 E2E+core/service 单测；GUI-08→g6 E2E + G6 验收方 52 项探针（含 overlap 10，矩阵如实标注来源）；GUI-09→g4 撤销面 + G6 cancelByOwner 矩阵 + 迟到拒收；GUI-10→g6 采纳指引+确切修订；GUI-11→见工作项 3；GUI-12→shell-contract 词汇表/redaction/发送方校验 + CSP meta + E2E 无 64 位 hex token 断言 + G5-R1 逐字节保真；GUI-13→性能基线（工作项 4）+ 轮询 2s 有界（G6 已验）；GUI-14→deb 断言 | `P6-G-total-matrix.md` 逐行、`packages/desktop/test/e2e-shell/*.spec.ts`、`packages/core/test/{g4-observability,anchor,g5-knowledge,g6-requests-inbox}.test.ts`、`packages/desktop/test/shell-contract.test.ts` |
| 3. 恢复矩阵（不重复任职/支出、不抢外部进程、不混淆撤权与回收） | **PASS（自动化部分）**。shell E2E 亲测三断言链：owned service **SIGKILL**→UI "disconnected"→重开同目录→同 workspace_id + 新 pid（`shell.e2e.spec.ts:200`）；外部服务附着后 UI 关闭/重启**绝不杀外部进程**，外部 SIGKILL→disconnected 检出（`:154`）；退出回收 owned 释放锁（`:69`）。g4 E2E：`workspace.restart`+重登记→**绑定以同代次 1 恢复**、双授权并存下撤销仅杀锚定授权、revoked≠disconnected 分列（`g4.e2e.spec.ts:66` 全链亲测）。撤权与回收不混淆：G6 cancelByOwner 独立审计+cleanup_pending 分列（前序已验收，本轮未回归——G7 无产品 src 变化） | `shell.e2e.spec.ts`、`g4.e2e.spec.ts`、G6-review §4.1 |
| 4. 性能实测，目标按计划记录基线，模型延迟另计 | **PASS**。造数集与计划 §15 完全一致（50 角色/200 外部会话/1000 请求/1000 修订、页大小 50）；验收方复跑六视图 p95 与开发侧同量级（最大 4.43ms vs 开发 7.32ms，参考目标 500ms）。**"实测记录而非宣称达标"属实**：脚本逐值记录、失败仅 NOTE 不判失败；JSON 含 in-process/mock/no-model-turns 限定与 REFERENCE ONLY 声明；报告明示"仅代表本机与该数据集，不宣称容量达标"。模型延迟未混入（零模型轮） | `packages/desktop/scripts/perf-baseline.mjs`、两份 perf-baseline.json、验收方 `/tmp/g7-review-perf.json` |
| 5. 原门禁+新增检查；区分 fixture 与真实宿主证据；总体对照、安装说明、已验证能力清单 | **PASS**。553/553 + 15/15 + 打包/冒烟/性能新增检查全部独立复跑通过；矩阵 fixture 列与待真机列严格分列（截图 fixture 标注、JSON 限定语、STEPS 汇总三处一致）；总体对照、真机安装说明（STEPS A–D 含升级迁移与移除保留工作空间）、已验证能力口径（AGENTS.md 进度行）齐备 | `P6-G-total-matrix.md`、`evidence/2026-10-28-p6-g7/STEPS.md`、AGENTS.md |

**退出条件**（06G7）："GUI 全矩阵有证据、安装无需开发仓库／终端、原会话与受管请求均真实跑通。交付 G7 和 P6-G 总体验收材料；未通过不转 P6-R、不远程发布。"——**自动化可达部分达成**：GUI 矩阵 14 项自动化列全绿且逐项可溯源；打包冒烟证明载荷二进制自足运行（无 node_modules、无终端）；原会话链 mock 全链+G3 真机证据在案，受管请求真实执行链 G6 在案。"干净系统安装/升级/移除"与"真实宿主复演"属真机材料（§6 裁定）；**"未通过不转 P6-R、不远程发布"被开发侧遵守**（AGENTS.md 已写明"未采齐不转 P6-R"）。

## 4. 重点独立核查结果（验收方亲测，非仅测试绿）

1. **打包冒烟真实运行于载荷**：运行期 `ps` 快照捕获到冒烟服务进程命令行为 `packages/desktop/dist-app-shell/linux-unpacked/resources/runtime/node/node …/resources/runtime/vendor/service-bundle.mjs --mock-workspace /tmp/roledock-g7-ws-*`——服务用**载荷自带锁定 Node** 与**载荷内 vendor bundle**，非仓库 node_modules/`.cache`；锚定步骤经 `packagedNode`+`packagedMcp`（脚本 84 行）走打包 MCP bundle。冒烟以 `env -u NODE_PATH -u NODE_OPTIONS` 复跑仍 6/6，产物活动绑定 generation 1。快照中另见一条开发模式服务（`.cache/runtime`+`dist-desktop/vendor`，workspace `RoleDock-g3-demo`）为**验收开始前已存在的残留进程**，非本轮产生，与打包冒烟无关。
2. **载荷纯净度**：asar 57 项与 deb 全清单均无 node_modules、源码路径、`.zcode`、examples、tests、spec；electron dist 的 LICENSE/LICENSES.chromium.html 属正常附带。唯一污染为 R1 的符号链接目标（§5）。
3. **12 项断言盲区**（R1 的成因）：断言 12 仅 `includes("./usr/bin/roledock-desktop")` 检查名字存在；"asar has no repo source paths" 只扫 asar 虚拟条目（本就不可能是绝对路径，近似恒真）——**deb 清单与符号链接目标从未被扫描**。
4. **性能诚实性**：脚本 `targets.note` 与报告措辞均不宣称达标；复现量级一致；造数集逐项与计划 §15 相同（含页大小 50）。测量口径为**进程内 coordinator 投影**（非 service RPC/GUI 往返）——JSON 已注明，矩阵行建议同步标注（O-4）。
5. **fixture/真实宿主不冒充**：GUI-04 mock 链的宿主在 UI 上显示 "idle / fixture"；矩阵、AGENTS.md、STEPS 三处对真机材料口径一致；G6 验收方探针在矩阵中被如实标注来源为验收方 52 项（G6 无产品 src 变化，证据仍有效）。
6. **无 `--no-sandbox`**：脚本与 src 全仓 grep 无命中；冒烟 `args: []`；非受管路径声明未翻转（B5-4 结论未被触碰）。
7. **恢复矩阵语义**：SIGKILL 恢复断言 workspace_id+pid 真实（亲测）；"代次不变"由 g4 restart 变体承载（同一条 SQLite 恢复路径），SIGKILL 变体本身未断言代次——矩阵措辞略超覆盖面（O-3）。

## 5. 返工项

### R1（高）：`.deb` 的 `/usr/bin/roledock-desktop` 符号链接指向构建机个人源码树，安装后悬空，且仓库路径被打进发布产物

- **触发条件**：对 `npm run desktop:pack:deb` 产物执行 `dpkg-deb -c` 或解包 `data.tar.zst`（验收方方法，§2）。开发侧产物（committed evidence，129,498,814 字节）与验收方重跑产物（129,497,850 字节）**同样受累**——缺陷在脚本，非一次性。
- **位置**：`packages/desktop/scripts/pack-deb.mjs:68`——`symlinkSync(join(payloadDir, "roledock-desktop"), join(debRoot, "usr", "bin", "roledock-desktop"))` 以**staging 根的绝对路径**为目标；实测链接目标为 `/home/inkem/Personal/RoleDock/packages/desktop/dist-app-shell/debroot/opt/RoleDock/roledock-desktop`。断言盲区在同文件 103–116 行（§4.3）。
- **影响**：违反 06G7 工作项 1 与本验收的明文重点（"打包载荷不含……仓库源码路径"）、desktop-gui-contract §8 定档的产物纯净意图、开发报告 §4 "control/入口正确" 的声明（入口存在但目标错误）；干净系统 `apt install` 后 `/usr/bin/roledock-desktop` 悬空（`.desktop` 入口 `Exec=/opt/RoleDock/roledock-desktop` 本身正确，菜单启动不受影响——故 GUI-01 菜单路径仍可真机验证，但包内启动器损坏且泄露构建者个人路径，属发布产物缺陷）。
- **修复要求**：符号链接目标改为相对路径 `../opt/RoleDock/roledock-desktop`（staging 与安装态同时成立）或绝对 `/opt/RoleDock/roledock-desktop`；**并补断言**：遍历 `dpkg-deb -c` 全部行,拒绝任何含 `/home/`、`/Personal/`、构建目录名的条目，并显式断言 `usr/bin/roledock-desktop` 的 `readlink` 目标恰为 `/opt/...`（或相对形式）——使"无源码路径/入口正确"成为被验证属性而非名字存在性；建议顺带把 O-2 的 asar 断言从"虚拟条目"扫描改为对解包后文件内容的路径引用扫描（可选）。重跑 `desktop:pack:deb` + `packaged-g7-evidence.mjs`，更新 `evidence/2026-10-28-p6-g7/pack-deb-result.json`（及如截图无变化可注明沿用）。
- **复验方法**：`dpkg-deb -c <新deb> | grep "/home/\|/Personal/"` 零命中；解包 data.tar `readlink usr/bin/roledock-desktop` 等于预期目标；12+ 新断言全过；打包冒烟 6/6 仍过。

### R2（低）：开发报告 §2 "electron-builder.deb.yml 删除" 与提交事实不符

- **触发条件**：`git show 323506d --stat`——该文件在 G7 提交中为**新增**（+34 行，deb target 配置），且工作区现存；无任何脚本引用它。
- **影响**：报告描述与所描述的提交不一致；该文件当前是无引用的声明性留档（`deb.priority` 非法问题在其注释语境中仍未标注），后续读者可能误以为它是生效构建路径。
- **修复要求**：二选一——真正删除该文件（pack-deb 已是唯一构建路径）；或保留并在文件头与报告 §2 注明"非生效路径,electron-builder 环境恢复后的备选配置,载荷断言脚本为验收器"。报告相应行同步更正。
- **复验方法**：文件存在性与报告文本一致；`grep -r electron-builder.deb.yml` 无脚本引用（或已删除）。

## 6. "材料待采"裁定（本轮明确写入）

真机材料（STEPS A–D：干净系统安装/首启/升级迁移/移除保留工作空间、打包产物上真实 ZCode 会话全链复演、真实发布与采纳、≥10 重叠请求真机轮次、三进程分别中止复演、键盘/焦点/分辨率/长正文人工检查，并合并 G4 gui-03…07、G5 知识页、G6 收件箱截图）**尚未采集**。裁定（沿 G4-review §6 先例）：

- **不构成本阶段 REWORK/BLOCKED**：自动化证据覆盖同版本代码的相同代码路径（本轮逐项核实，G7 无产品 src 变化使 G3 真机链/G6 探针证据继续有效）；无人值守边界已由计划 §0 预先裁定并如实分层,开发报告/矩阵/AGENTS.md 三处口径一致,无冒充。
- **但完整退出条件需真机闭环**：GUI-01/04/06/10/13/14 的真实环境材料采集完成前，P6-G 总体验收不能给完整 PASS，**不转 P6-R、不远程发布**（AGENTS.md 已记录）。真机复演时请按 STEPS.md 逐条留证,并注意 R1 修复后再采集安装类材料（A 组）。
- G6 遗留观察项 O-B/O-C（GUI 管理取消端到端 exercise、owner 取消 running 的适配器实际停止行为）已按 G6 建议并入 STEPS 真机复演范围,G7 报告 §8.3 如实承接。

## 7. 观察项（不影响本阶段结论）

- **O-1（低）**：asar/vendor 混入 G0 冻结探针构建的 `vendor/main.mjs`+`vendor/preload.cjs`（约 1.4MB 死载荷,shell 不引用）——`pack-deb.mjs` 整目录拷贝所致；建议拷贝白名单化为三个 bundle。
- **O-2（低）**："asar has no repo source paths" 断言近似恒真（asar 条目为虚拟相对路径,见 §4.3）；随 R1 把验收重心移到 deb 清单/符号链接扫描。
- **O-3（低）**：矩阵 GUI-11 "SIGKILL 变体由 crash 用例覆盖(kill -9 语义)" 对 workspace_id/pid 成立;"代次不变"实际由 g4 restart 变体承载（同一恢复路径）。建议矩阵措辞区分两者。
- **O-4（记录）**：矩阵 GUI-13 "owner 读视图 p95" 未标注测量口径为进程内 coordinator 投影（JSON 有注）；建议矩阵行补"in-process"限定,避免被读作 GUI 端到端延迟。
- **O-5（记录）**："确定性组装"指固定输入的内容确定性;asar 头含时间戳,两次构建字节数差 964（129,498,814 vs 129,497,850）,非字节级可复现。无声明违规,留档备查。
- **O-6（承接）**：G6 O-C（owner 取消 running 不调 `adapter.cancel`）随真机复演确认,开发报告 §8.3 已如实列出。

## 8. 测试真实性总评

各层证据均为真实运行且含行为断言：shell E2E 用 SIGKILL/锁竞争/SQLITE_BUSY/进程存活轮询等可观察行为断言,非逐字复述;打包断言对本轮产物真实生效（除 R1 盲区外全部独立复核成立）;冒烟 6 检查有 0600 权限位、锚定 payload 字段、GUI 文案三类实质断言;性能脚本逐值落盘且复现。开发报告声明的数字（553/553、15/15、12/12、6/6、p95 数字）与验收方独立运行一致;fixture 与真实宿主证据严格分列,无冒充;失败/返工记录如实。发现的问题集中于打包产物正确性（R1）与文档一致性（R2）,不涉及权限、状态机或身份边界。

## 9. 范围限制

- 未独立重跑真机步骤（需真实 ZCode 桌面会话与用户配合）——按 §6 裁定待采。
- 未重跑 `npm run desktop:e2e`（probe 回归）与 `desktop:package:shell`（electron-builder shell dir 目标,其下载代理在本环境不可用为开发侧记录,验收方未复现该环境限制）。
- shell E2E 以 `desktop:build:shell` 刷新产物后按提示词命令独立运行;未复跑开发侧证据采集。
- 验收方临时材料位于 `/tmp/g7-review-*`（check/shell-e2e/packdeb/packaged/perf 日志、`g7-asar-list.txt`、`g7-deb-c.txt`、`g7-deb-extract/`、`g7-review-packaged-evidence.json/png`、`g7-review-perf.json`、`g7-review-ps-snapshot.txt`）与 `/tmp/g7-asar-list.txt`,不入库;验收结束工作区干净。

**P6-G7 结论：REWORK**——完成 R1（符号链接目标修复 + deb 清单/链接目标断言 + 重跑打包与冒烟并更新证据）与 R2（报告/文件一致性）后,本阶段自动化范围即成立,可按 §6 口径进入"真机材料待采"状态;真机材料采齐前不转 P6-R、不远程发布。本轮不自动开始修复、不提交、不发布;本报告不授予合并或发布权限。
