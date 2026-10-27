# P6-G3 Discovery Spike（真机实测记录）

日期：2026-10-27。CLI：`/opt/ZCode/resources/glm/zcode.cjs`（app-server JSON-RPC over stdio）。
脚本：`spike-list.mjs`（建/枚举/跨实例）、`spike-resume.mjs`（持久化桌面会话只读 resume）、`spike-listonly.mjs`（零附着纯 list）。
原始输出见本目录各 `.mjs` 运行记录（本文件为裁定摘要）；全程零模型轮。

## 实测结论

1. **`session/list` 是工作空间存储级枚举**：全新 app-server 实例、零附着、零创建，对 RoleDock 工作空间一次 `session/list` 返回全部 9 个持久化会话（sessionId、title、status、sessionKind），其中包括用户正在使用的 ZCode 桌面会话（`session_45a2f1dacb80a1fcdf1bcfafff373113`，标题"执行…DESKTOP_GUI_PLAN.md的G3"）。`adapters/zcode/src/reference-connector.ts:341` 处"list does not surface non-attached sessions"的注释对当前 CLI 版本不成立（旧版行为）。
2. **跨实例 `session/resume` 对持久化桌面会话成功**：新实例 resume `session_d696ab0fa1f8294c14655bf0d0ee4ffb`（用户 2026-10-25 G0 会话）返回 session 元数据（title/status/workspace），`session/read` 同步可读。identity oracle（`zcode_verify_session`→resume）对真实桌面会话有效。
3. **app-server `session/create` 造出的 `sess_<uuid>` 会话是实例内存态**：不落入 `~/.zcode/cli/db/db.sqlite`（实测查询 NOT IN DB），实例退出后跨实例 resume 返回 `Session not found (-32004)`。与 B5 受管 spawn 模型一致：受管 consultation 会话生命周期由其连接器进程持有。**通道归属结构性可辨**：持久化桌面会话 `session_*`（用户原会话）vs 实例内存会话 `sess_*`（受管/诊断新建）。
4. **客户端交互应答必需**：app-server 在首个请求前发 `session/requestRuntimePreferences`，须应答（参考连接器已实现）；`interaction/requestProviderRuntimeHeaders` 未配 helper 时如实报 `headersApplied:false` 不阻塞读操作。

## 对 G3 的裁定

- **发现路径可行**：GUI 可经 `zcode_list_sessions`（新 connector 工具，包装 `session/list`）显示真实候选列表；无需用户手抄 host_session_id，但粘贴引用保留为后备（DESKTOP_GUI_PLAN §11.6）。
- **登记验证有效**：`externalSessions.register`→adapter `verifyExternalSession`（resume，零模型轮）可直接验证用户桌面原会话身份。
- **真实载入路径成立**：用户桌面会话经其 MCP 客户端显式调 `sessions.anchor`；材料载入轮经服务侧连接器 resume 同一 `session_*` 发送，轮次落在用户桌面会话中可见。
- 无产品集成阻塞；不涉及受管隔离声明变化（原会话接入仍走 restricted 声明面，受管 consultation 独立）。
