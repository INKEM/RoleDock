# ZCode 受限接入（P5-H）

日期：2026-10-14；状态：[独立验收](phase-reports/P5-H-review.md)结论P5-H BLOCKED。2026-10-24 起按 [ADR-0011](adr/0011-human-authorization-entry-reservation.md) 增量收口（B0–B4 + G-min，契约见 `docs/zcode-connector-tools.md`）：B1 会话身份验证；B2 真人授权入口内部接口；B3 材料载入与对账；**G-min GUI 确认入口（gui-confirm，真实锚定全链）**；**B4 资源控制与继承——`zcode_cancel`/`zcode_close`（官方 stop/close）、`createSession` 带 bootstrap 真实载入、05H 八步链 1–6 步真实跑通（真人事件→锚定 gen1→角色动作 propose/publish→跨会话继承 gen2→旧授权撤销；3 次真实材料载入轮）**，证据见 `phase-reports/evidence/2026-10-24-p5-h-b4/`。2026-10-25 起按 [ADR-0012](adr/0012-adapter-enforced-isolation.md) 增量收口（B5 系列，见 `docs/ADAPTER_SANDBOX_PLAN.md`）：**B5-0 契约预留、B5-1 受管沙箱执行技术验证——连接器 `--sandbox`（bubblewrap 0.6.1 受管 spawn，runner 缺失即 NOT_IMPLEMENTED 失败关闭）+ `--sandbox-egress` 出口白名单（伪 loopback IP + hosts 钉扎 + Unix socket 转发），沙箱内真实模型轮与并发 3 实例烟测通过**；**B5-2 逃逸测试证据集——§4 矩阵八行全数拦截（根只读边界：白名单外写入 EROFS；跨 netns/非白名单网络结构性拒绝；嵌套进程/插件等价子进程边界不衰减；mount/unshare/setns EPERM；runner 缺失/启动失败/中途消亡如实 NOT_IMPLEMENTED/uncertain 不降级；行 4 真实模型轮内 Bash 工具可运行而效果限边界内）**；**B5-3 请求链受管接入——适配器受管变体（`managed:{egress}`，经 `zcode_sandbox_status` 验证后声明 full 隔离，失败关闭）+ `capability_scope`/`temp_dir` 生效 + 材料目录只读白名单，05H 步骤 7 十个重叠请求在沙箱实例真实完成（10 会话 instance_id=NULL、10 artifact/inbox、零主会话注入）、步骤 8 收件箱显式采纳（candidate source=request.result state=adopted）、预算/取消受管回归通过**；**B5-4 声明翻转与收口——05H 八步全链在受管连接器上一次完整跑通（预算支出前拒绝 seq 不变、gen1→gen2 继承、旧授权撤销、10 重叠请求、显式采纳）、受管变体进入 `defineAdapterContractSuite`（10 用例协议一致性全过）、验收前置 N1（cgroup 非必要条件裁定落档）与 N2（矩阵行 5 正则修复重跑 41 项全过）完成，四项隔离声明随受管执行声明翻转（受管变体与沙箱验证绑定；非受管保持 restricted/false），G01-Z03 证据完备待独立验收裁定**，证据见 `phase-reports/evidence/2026-10-24-p5-h-b5-1/`、`2026-10-25-p5-h-b5-2/`、`2026-10-25-p5-h-b5-3/` 与 `2026-10-25-p5-h-b5-4/`，runner 定档见 `docs/toolchain.md`。声明现状：`current_session_identity`/`human_authorization_events`/`load_materials`/`reconcile_load`/`cancel` = true（各自增量真实证据）；**四项隔离自 B5-4 起随受管执行声明翻转：受管变体（`managed:{egress}` 构造）= level full + 四项 true，与 `zcode_sandbox_status` 运行时验证绑定、失败关闭；非受管构造保持 restricted/false。受管证据链（B5-1 真实模型轮、B5-2 逃逸矩阵全拦截、B5-3 步骤 7–8、B5-4 八步全链）已备齐，G01-Z03 关闭与 P5-H 解除 BLOCKED 待独立验收裁定**；取消/关闭/支出前预算证据已具备（G01-Z04 可评审关闭）。

用户已指定 ZCode。实际环境为 Desktop 3.15.3、bundled CLI 0.16.9；CLI 内另有 runtime 包装元数据0.13.3，不能混作同一版本。执行入口为 `node /opt/ZCode/resources/glm/zcode.cjs`；`/usr/bin/zcode` 指向桌面 Electron 程序。本轮通过已配置 zcode-delegation 0.1.0 MCP 连接器和 GLM-5.3 账户模型执行真实诊断，不直接读模型凭据或调用模型 API。

## 可运行范围

`@roledock/adapter-zcode` 暴露 `ZCodeAdapter`、`connectZCodeConnector` 和 `roledock-zcode-probe`。两种构造：**非受管**（默认）= restricted、四项隔离 false，仅诊断会话；**受管**（`managed:{egress}`）= full、四项隔离 true，会话经受管沙箱执行（主锚定会话在产品形态中不沙箱）。下表按受管/非受管分别标注。

| 操作 | 当前行为 |
| --- | --- |
| 裸诊断 createSession/runTurn/getResult | 通过受信MCP连接器调用真实ZCode；发送须有execution_key；只取完整、连续、单轮次的匹配终态 |
| bootstrap / capability_scope / temp_dir | bootstrap：受管/非受管均真实载入（B4）；`capability_scope`/`temp_dir`：非受管 NOT_IMPLEMENTED，受管生效（冻结入 journal，temp_dir 在工作空间白名单内） |
| 外部会话登记/人类授权/载入/载入对账 | 已声明（B1–B4 真实证据）；不读取或冒用已有私人聊天 |
| 独立RoleDock请求 | 受管变体：经核心隔离门禁在沙箱实例执行（05H 步骤 7–8 真实证据）；非受管：核心隔离门禁拒绝，零宿主轮次 |
| 按创建键查询 | 只恢复本地已确认映射；持久未知intent抛uncertain，绝不返回“未发生”或重新创建 |
| cancel/nativeResume/nativeFork | cancel 已声明（官方 session/stop，取消后阻止新轮次）；resume/fork 不声明、不伪装支持 |
| closeSession | 已声明（B4 官方 session/close；closed 句柄报 closed 状态并拒绝新轮次，按创建键查询返回 null） |

## 诊断命令

先构建，再指定已受信且已有账户配置的连接器路径，以及新的专用临时工作空间和journal目录：

```text
node adapters/zcode/dist/bin.js --connector <连接器.mjs的绝对路径> --workspace <专用诊断目录绝对路径> --state-dir <journal目录绝对路径>
```

不要把未经审查的程序当作connector。本轮连接器来自当前用户已配置的ZCode MCP入口，不将该个人路径或账户实现硬编码进包。连接器的文件哈希和运行版本随证据固定。

首次命令取得实际模型答案；同一journal重跑读取confirmed-prior-answer，不新发轮次。未知创建/发送不能靠重跑诊断绕过。connector transport使用独立的自有进程组，断开时只清理这个进程组；不触碰现有ZCode桌面或其他会话。进程退出不是远端模型取消或持久宿主会话关闭证据。初始化失败也必须断开已启动的connector。

模型内部token花费/生成字节不能由当前接口在支出前限制。诊断预算只限制新发送轮次/期限和结果接纳；超输出或迟到只拒收，不保证模型已停止。诊断提示词中的“不要使用工具”同样不是权限隔离。

## 当前外部缺口

1. **真人来源认证**：官方 [UserPromptSubmit Hook](https://zcode.z.ai/en/docs/hooks) 接收提交文本，但程序session/send也走此路径。本轮实际程序消息被记录为realUser/real_user，client_id却是legacy-session-send。角色授权必须依赖另外可验证的受信人类入口，不能把这些标签或模型转述作为凭据。
2. **原会话完整材料确认**：官方Hooks支持additionalContext，但本机实现存在长度截断，当前连接器无完整载入/确认接口；还须解决锚定工具等待载入时与宿主当前轮次的时序。仅安装 [MCP](https://zcode.z.ai/en/docs/mcp-services) 不证明已载入材料。
3. **上下文/工具/写入/结果隔离**：必须证明限制覆盖内置工具、全局/插件MCP和嵌套Agent。本轮诊断会话的元数据仍列出Bash/Write/Agent等工具；没有执行这些工具，也不据提示词宣布范围已被强制执行。
4. **副作用对账及资源控制**：当前连接器无可靠创建/发送幂等键、取消及会话关闭接口。官方CLI已有app-server命令不等于所有底层方法均成为受支持接入契约。未知副作用须保持待对账。

受信所有者的owner-selection可验证本地授权逻辑，但不能替代P5-H要求的真人在ZCode原会话授权闭环。真实角色工作、继承、旧主撤权、10个实际重叠请求、答案artifact/收件箱采纳及跨Harness迁移仍未通过。详见ADR-0010与P5-H阶段报告。
