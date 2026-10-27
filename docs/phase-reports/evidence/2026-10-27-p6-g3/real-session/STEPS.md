# P6-G3 真实 ZCode 桌面原会话证据 — 操作清单

目标：用户在 ZCode 桌面打开的原会话，经 GUI 确认 → 受信桥推进授权 → Agent 显式锚定 → 载入 → active binding 的全链真机证据。桌面 shell 已在屏幕上打开（userData 已预配置真实 ZCode 接入：CLI + 凭据 helper + GLM-5.3）。

## 你需要做的（按顺序）

1. **RoleDock shell 窗口**（已打开的"RoleDock"窗口）：
   - 工作空间页 → 选择目录 → 选 `/home/inkem/Personal/RoleDock-g3-demo` → 模式选 **zcode** → 打开。
   - 角色库页 → 安装角色包 → 选 `/home/inkem/Personal/RoleDock/examples/demo-team` → 给 **builder** 授予 **documents.read**。
2. **ZCode 桌面 app**：新开一个会话，工作目录选 `/home/inkem/Personal/RoleDock-g3-demo`（这就是"原会话"）。给它添加一个 MCP server（用你平时的方式，如 /mcp 或项目 MCP 配置）：
   ```json
   { "mcpServers": { "roledock": {
       "command": "node",
       "args": ["/home/inkem/Personal/RoleDock/packages/mcp/dist/bin.js"],
       "env": { "ROLEDOCK_CREDENTIAL_FILE": "/home/inkem/Personal/RoleDock-g3-demo/.roledock/mcp-session.env" }
   } } }
   ```
   此刻凭据文件还不存在（下一步登记后由桌面写入），MCP 连接失败是预期现象，登记后重连即可。
3. **RoleDock shell → 授权与会话页** → 点"发现宿主会话"→ 应能看到你刚开的会话（按标题/时间辨认）→ 点该行的"登记"。成功后日志显示已登记 ext-… 与凭据文件路径。回到 ZCode 会话重连 MCP（应能列出 roledock 工具）。
4. **RoleDock shell → 授权与会话页**：在该会话行选角色 **builder**（能力 documents.read，应显示"已授予"）、继承 initialize、有效期 8 小时 → 点一次 **确认**（此时可截一张 GUI 图）。
5. **ZCode 原会话**：让 Agent 执行锚定，例如发送：
   > 调用 roledock 的 authorizations.get 查看你的授权，然后用 sessions.anchor 显式锚定（idempotency_key 用 anchor-g3-real）。
   Agent 调用 sessions.anchor 会触发一次**真实材料载入模型轮**（约 1 轮额度，载入 RoleDock 角色材料）。请在会话里批准工具调用，并截图 Agent 的工具调用与结果。
6. **RoleDock shell → 授权与会话页**：进度链应走到 **active · 角色 builder @ 代次 1**（截一张图）。把过程中任何报错也截下来。

完成后告诉我"做完了"（或卡在哪一步），我会运行 collect-state.mjs 采集后端关联证据（external_session_id / event_ref / authorization_id / attempt / binding 代次），并核对会话 ID 前后一致。

注意：过程中让 ZCode 原会话保持空闲（材料载入时若有待答复的权限请求会如实转 uncertain，重试即可）。
