# P6-G4 真机验证步骤（真实 ZCode 桌面原会话）

自动化证据在 `automated/`（mock 工作空间全链截图与 E2E 日志）。本文件是**真机补充证据**的操作步骤：G4 的撤销面、双授权并存、重启恢复与可观测性在真实 ZCode 桌会话上的表现，同时补拍 G3 验收观察 O1 要求的两张截图。截图/日志中不得出现 token、owner-connection 内容等凭据。

前置：`npm run build && npm run desktop:build:shell` 完成；本仓库工作树为待验收状态。

## 步骤

1. **打开真实工作空间**：启动 shell（`node packages/desktop/dist-desktop/shell/main.mjs` 或打包产物），打开 zcode 模式工作空间目录（沿用 2026-10-27-p6-g3 的工作空间亦可；迁移 8 会在打开时自动补列，旧记录的 `confirmed_at`/`state_changed_at` 如实为空，不回填）。
2. **发现并登记原会话**：`授权确认` 页 → `发现宿主会话` → 登记你本人的 ZCode 桌面会话（若 G3 已登记且 `mcp-session.env` 仍有效，可跳过重登记；重启过服务则必须重新登记刷新凭据）。
3. **确认 + 锚定（O1 补拍第一张）**：确认一条 1h 授权 → 受信桥推进 → 在 ZCode 桌面会话用 MCP 调 `sessions.anchor` → 锚定成功后**截取确认进度链 active 状态**（G3 证据缺失的成功态截图）→ 存 `gui-03-real-active-chain.png`。
4. **会话观察块（O1 补拍第二张）**：同一页面下方 `会话观察（代次·载入·撤销）`：应看到 连接 running 与角色有效性 active 并列、代次时间线（generation、实例、知识版本、能力、来源）、锚定尝试（已确认 v1）、载入记录（材料版本+确认时间）→ 截全块 → 存 `gui-04-real-observability.png`。
5. **双授权并存**：`node submit-second-auth.mjs <工作空间目录>`（owner 面写 8h takeover 事件，桥自动推进；GUI 确认面此时按 G3 定档会拒绝二次确认，属预期）。等进度链出现第二条"授权已生成（未撤销）"。
6. **撤销面**：在会话观察块点 `撤销预览：<auth1>` → 模态显示将失效的绑定（代次 1）与将撤权的委派请求 → 截 `gui-05-real-revoke-preview.png` → 点 `确认撤销` → 观察角色有效性变 `已撤销（revoked）` 而 `连接：服务 running` 保持不变；第二条 8h 授权记录不受影响 → 截 `gui-06-real-revoked-split.png`。
7. **重启恢复（代次不变）**：shell `工作空间` 页 `重启服务` → 重新登记（刷新 `mcp-session.env`）→ 在原会话重新挂载 MCP 后 `authorizations.get` 应见未撤销的 8h 授权、`sessions.binding` 应显示 `revoked`/原代次（或换新会话 takeover 后代次 +1，旧实例 superseded）→ 截 `gui-07-real-after-restart.png`。
8. **导出后端状态**：`node collect-state.mjs <工作空间目录> backend-state-real.json`（含 confirmations/bindings/attempts/loads 四视图与 runtimeStatus）。

## 记录

- 每步记下时间点、host_session_id、authorization_id（公开标识可全文保留）。
- 完成后在本目录补 `FINDINGS.md`：与自动化证据（`automated/`）对照的结论、任何不一致与怀疑点。
- 若 GUI 显示与后端状态不一致，属于缺陷：记录编号并在开发报告"遗留与风险"中登记，不掩饰。
