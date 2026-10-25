# P5-A 共享服务与 MCP

状态：[P5-A 独立验收 PASS](phase-reports/P5-A-review.md)；Linux 本地传输。真实宿主接入与GUI属于P5-H/P6-G。

## 受信控制器用法

`WorkspaceService.start({root,adapter,socketPath})`打开一个Coordinator，所有者策略与Agent连接共用该writer；root中的旧CLI直接开库会明确报WORKSPACE_LOCKED。关闭调用`await service.close()`。服务adapter必须与已授权真实接入组件匹配；本阶段只交付Mock验证，不自动选择宿主。

```ts
import { WorkspaceService, ServiceClient } from '@roledock/service';
import type { ServiceCredential } from '@roledock/service';
import type { ExternalSession } from '@roledock/protocol';

const service = await WorkspaceService.start({ root, adapter, socketPath });
const owner = new ServiceClient(service.ownerCredential);
await owner.call('roles.install', { source_path: rolePackPath });
await owner.call('policy.grant', { role_id: installedRoleId, capability: 'documents.read' });
const trustedCredential = await owner.call<ServiceCredential>('connections.trust', {
  subject: verifiedHostConnectionSubject,
  capability_ceiling: ['documents.read'],
});
const trusted = new ServiceClient(trustedCredential);
const enrollment = await trusted.call<{
  external_session: ExternalSession;
  credential: ServiceCredential;
}>('externalSessions.register', {
  host_session_id: verifiedCurrentHostSessionId,
});
await trusted.call('authorizations.recordHuman', {
  external_session_id: enrollment.external_session.external_session_id,
  event_ref: originalHumanEventRef,
});
```

上述主体/宿主ID/事件必须由受信接入组件和adapter验证；不得取自模型转述或工具结果文字。所有者可以用authorizations.recordOwner明确登记结构化授权作为降级，来源会显示owner-selection。真实人类授权能力缺失时禁止伪称纯会话授权。

登记后`enrollment.credential`只能交给**该外部会话的受信工具启动器**；不得写入角色知识、对话、工具参数或其他会话。普通Agent通过独立的ServiceClient只调用自己连接面：

```ts
import type { RoleAuthorization, SessionBinding } from '@roledock/protocol';

const agent = new ServiceClient(enrollment.credential);
const { authorizations } = await agent.call<{ authorizations: RoleAuthorization[] }>('authorizations.get');
const outcome = await agent.call('sessions.anchor', {
  authorization_id: authorizations[0].authorization_id,
  idempotency_key: stableLocalAttemptKey,
});
const { binding } = await agent.call<{ binding: SessionBinding | null }>('sessions.binding');
```

先核对attempt.state和binding.state，只有实时active才开始正式角色工作；uncertain调用sessions.reconcile，不以新key盲目重试。普通连接没有管理员/授权签发/宿主身份登记接口，也没有打开数据库的能力。

## MCP stdio 启动

构建后由受信启动器设置该会话凭据：

```text
ROLEDOCK_SERVICE_SOCKET=<该服务的绝对socket路径>
ROLEDOCK_SESSION_TOKEN=<该外部会话的独立session token>
node packages/mcp/dist/bin.js
```

MCP使用官方SDK1.32.1，通过stdio提供14个会话工具；不自行打开工作空间，不读owner凭据文件，不把MCP协议session当作聊天身份。调用者无session_id参数；角色授权来自受信控制面而非工具文字。原会话的身份、授权来源和材料载入由P5-H adapter证明，MCP不能自动发现任意聊天。

## 本地Mock服务

`node packages/service/dist/bin.js --mock-workspace <绝对工作空间路径>`可运行管理服务，owner连接保存在`.roledock/owner-connection.json`（0600，仅本地所有者）。内置一个明确的fixture已有会话`mock-existing-conversation`，主体`mock-fixture-subject`，可以由所有者经connections.trust登记并使用owner-selection授权验证状态。它没有真实人类消息源，也不运行真实模型。SIGTERM关闭服务并删除owner文件；SIGKILL后新服务恢复状态、更换全部bearer。既有文件或活socket不会被当作可覆盖的陈旧端点。

生产托管可通过模块API注入adapter；不提供任意动态模块加载或Shell命令配置。仅Mock/固定fixture/MCP进程证据不能解除G01。参见[锚定规范](spec/external-session-anchor.md)和[桌面实施计划](DESKTOP_GUI_PLAN.md)。
