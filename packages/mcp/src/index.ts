import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ServiceClient } from "@roledock/service";
import { RoleDockError, toErrorEnvelope } from "@roledock/protocol";

const string = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 0 };
function tool(name: string, description: string, properties: Record<string, object>, required: string[] = Object.keys(properties)): Tool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
export const SESSION_TOOLS: readonly Tool[] = [
  tool("authorizations.get", "Read applicable human or owner authorizations for this authenticated external conversation.", {}),
  tool("sessions.anchor", "Explicitly anchor this existing conversation using its own authorization. Active requires confirmed material load and committed primary CAS.", { authorization_id: string, idempotency_key: string }),
  tool("sessions.binding", "Read this connection's actual binding, generation, current effective capabilities and source.", {}),
  tool("sessions.reconcile", "Query the original persisted load attempt after uncertain delivery; never blindly create a successor.", { attempt_id: string }),
  tool("sessions.release", "Release this conversation's binding and withdraw its delegated unfinished tasks.", {}),
  tool("documents.list", "List visible role documents using this binding.", { role_id: string }, []),
  tool("documents.read", "Read a document and record a verified read receipt for this connection.", { document_key: string, target_role_id: string, revision: { type: "integer", minimum: 1 } }, ["document_key"]),
  tool("documents.propose", "Propose a candidate without granting formal publishing rights.", { target_role_id: string, document_key: string, body: string, note: string, baseline_revision: integer }, ["target_role_id", "document_key", "body"]),
  tool("documents.publish", "Publish with actual owner, current primary generation and revision checks.", { document_key: string, body: string, expected_revision: integer, expected_generation: { type: "integer", minimum: 1 }, candidate_id: string, adopt_artifact_id: string }, ["document_key", "body", "expected_revision", "expected_generation"]),
  tool("requests.create", "Receive an isolated request with a fixed target generation and snapshot; results are not injected into the primary conversation.", { target_role_id: string, question: string, idempotency_key: string, read_exception_rationale: string,
    budget: { type: "object", properties: { max_turns: { type: "integer", minimum: 1 }, max_output_bytes: integer, deadline: { type: "string", format: "date-time" } }, additionalProperties: false } }, ["target_role_id", "question", "idempotency_key"]),
  tool("requests.get", "Read a request that this actual binding participates in.", { request_id: string }),
  tool("requests.reply", "Reply to an awaiting consultation within its original budget.", { request_id: string, body: string }),
  tool("requests.cancel", "Cancel a permitted request; late completion cannot revive its state.", { request_id: string }),
  tool("artifacts.read", "Read a permitted completed answer body and its content hash.", { artifact_id: string }),
  tool("inbox.list", "Read THIS binding role's own result inbox (unread/read dimensions, paged; results are merged here, never injected into the primary conversation).", { unread_only: { type: "boolean" }, cursor: string, limit: { type: "integer", minimum: 1, maximum: 200 } }, []),
];
/** The MCP process is only a client of the existing writer, with an issued session credential. */
export function createSessionMcpServer(client: ServiceClient): Server {
  const server = new Server({ name: "roledock-session", version: "0.1.0-alpha.0" }, {
    capabilities: { tools: {} }, instructions: "This connection acts only as its registered external conversation. Read authorizations, explicitly anchor, and verify active binding before role work. Tools cannot register identities, sign authorizations or invoke workspace administration.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(SESSION_TOOLS) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (!SESSION_TOOLS.some(item => item.name === request.params.name)) throw new RoleDockError("PERMISSION_DENIED", "Unknown or privileged tool is unavailable.");
      const result = await client.call(request.params.name, request.params.arguments ?? {});
      const status = result as { attempt?: { state?: string }; binding?: { state?: string } };
      const failed = status.attempt?.state === "failed";
      return { content: [{ type: "text", text: JSON.stringify({ ok: !failed, result }) }], ...(failed ? { isError: true } : {}) };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(toErrorEnvelope(error)) }] };
    }
  });
  return server;
}
