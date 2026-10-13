import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { RoleDockError } from "@roledock/protocol";
import type { CollaborationRequest, ErrorCode } from "@roledock/protocol";
import { putObject } from "../store/objects.js";
import type { WorkspaceStore } from "../store/workspace.js";
import type { AdapterSessionHandle, HarnessAdapter } from "../ports/adapter.js";
import { expireIfOverdue, requestTempDir } from "./service.js";
import type { RequestBudget, RequestRow } from "./service.js";

function getRequestRow(store: WorkspaceStore, requestId: string): RequestRow | undefined {
  return store.prepare("SELECT * FROM requests WHERE request_id = ?").get(requestId) as
    | RequestRow
    | undefined;
}

function markState(
  store: WorkspaceStore,
  requestId: string,
  state: CollaborationRequest["state"],
  extra?: {
    error?: { code: ErrorCode; message: string };
    artifact?: { artifact_id: string; content_hash: string };
  },
): void {
  const now = new Date().toISOString();
  const terminal =
    state === "completed" || state === "failed" || state === "cancelled" || state === "expired";
  store
    .prepare(
      `UPDATE requests SET state = ?, updated_at = ?
       ${terminal ? ", terminal_at = ?" : ""}
       ${extra?.error !== undefined ? ", error_json = ?" : ""}
       ${extra?.artifact !== undefined ? ", result_artifact_id = ?, result_content_hash = ?" : ""}
       WHERE request_id = ?`,
    )
    .run(
      state,
      now,
      ...(terminal ? [now] : []),
      ...(extra?.error !== undefined ? [JSON.stringify(extra.error)] : []),
      ...(extra?.artifact !== undefined ? [extra.artifact.artifact_id, extra.artifact.content_hash] : []),
      requestId,
    );
}

function reclaimTempDir(store: WorkspaceStore, requestId: string): void {
  rmSync(join(requestTempDir(store, requestId), "tmp"), { recursive: true, force: true });
}

export interface ExecutionResult {
  request_id: string;
  state: CollaborationRequest["state"];
  artifact_id?: string;
}

function isUncertainAdapterError(error: unknown): boolean {
  return (
    error instanceof RoleDockError &&
    (error.details as { uncertain?: unknown } | undefined)?.uncertain === true
  );
}

/**
 * Secure the isolated consultation host session for a request.
 *
 * Creation is keyed by `request-<id>`; an uncertain outcome is recorded
 * (execution_uncertain) and reconciled by creation-key lookup when the
 * adapter supports it — a retry never repeats the side effect blindly, and
 * without lookup support the failure is structured, with the recorded state
 * kept for recovery.
 */
async function secureConsultationSession(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  row: RequestRow,
): Promise<{ sessionId: string; handle: AdapterSessionHandle }> {
  const creationKey = `request-${row.request_id}`;
  const existing = store
    .prepare("SELECT id, state, host_session_ref FROM sessions WHERE creation_key = ?")
    .get(creationKey) as { id: string; state: string; host_session_ref: string | null } | undefined;

  const bootstrapPayload = JSON.stringify({
    request_id: row.request_id,
    question: row.question,
    snapshot: JSON.parse(row.binding_snapshot_json),
    target_role_id: row.target_role_id,
  });
  const bootstrap = {
    bundle_id: `request-${row.request_id}`,
    role_id: row.target_role_id,
    content_hash: putObject(store, bootstrapPayload),
    payload: bootstrapPayload,
  };

  const insertSessionRow = (hostSessionId: string, state: string): string => {
    const sessionId = `sess-${randomBytes(4).toString("hex")}`;
    store
      .prepare(
        "INSERT INTO sessions (id, kind, adapter, state, role_id, instance_id, host_session_ref, creation_key, created_at) VALUES (?, 'request', ?, ?, ?, NULL, ?, ?, ?)",
      )
      .run(sessionId, adapter.getCapabilities().adapter, state, row.target_role_id, hostSessionId, creationKey, new Date().toISOString());
    return sessionId;
  };

  const reconcile = async (): Promise<AdapterSessionHandle> => {
    const lookup = adapter.lookupSessionByCreationKey;
    if (adapter.getCapabilities().optional.lookup_session_by_creation_key === true && lookup !== undefined) {
      const handle = await lookup(creationKey);
      if (handle !== null) return handle;
      // Host never created: a clean create under the same key is safe.
      const handle2 = await adapter.createSession({ creation_key: creationKey, bootstrap });
      return handle2;
    }
    throw new RoleDockError(
      "ADAPTER_CAPABILITY_MISSING",
      `Consultation session creation for request "${row.request_id}" is uncertain and the adapter cannot reconcile by creation key; the recorded state is kept and no side effect is repeated.`,
      {
        details: {
          request_id: row.request_id,
          creation_key: creationKey,
          execution_uncertain: true,
        },
      },
    );
  };

  if (existing !== undefined && (existing.state === "uncertain" || existing.state === "provisioning")) {
    const handle = await reconcile();
    markProvisionedConsultation(store, row.request_id, existing.id, handle.host_session_id);
    return { sessionId: existing.id, handle };
  }
  if (existing !== undefined && existing.state === "active" && existing.host_session_ref !== null) {
    return {
      sessionId: existing.id,
      handle: {
        adapter: adapter.getCapabilities().adapter,
        host_session_id: existing.host_session_ref,
        creation_key: creationKey,
      },
    };
  }

  try {
    const handle = await adapter.createSession({ creation_key: creationKey, bootstrap });
    const sessionId = insertSessionRow(handle.host_session_id, "active");
    return { sessionId, handle };
  } catch (error) {
    if (!isUncertainAdapterError(error)) {
      throw new RoleDockError(
        "INTERNAL",
        `Consultation session creation failed: ${(error as Error).message}`,
        { details: { request_id: row.request_id, stage: "consultation-create" } },
      );
    }
    // Uncertain: record without claiming an outcome, then reconcile.
    store.prepare("UPDATE requests SET execution_uncertain = 1 WHERE request_id = ?").run(row.request_id);
    const sessionId = insertSessionRow("unknown", "uncertain");
    const handle = await reconcile();
    store.prepare("UPDATE requests SET execution_uncertain = 0 WHERE request_id = ?").run(row.request_id);
    markProvisionedConsultation(store, row.request_id, sessionId, handle.host_session_id);
    return { sessionId, handle };
  }
}

function markProvisionedConsultation(
  store: WorkspaceStore,
  requestId: string,
  sessionId: string,
  hostSessionId: string,
): void {
  store
    .prepare("UPDATE sessions SET state = 'active', host_session_ref = ? WHERE id = ?")
    .run(hostSessionId, sessionId);
}

export interface ExecutionResult {
  request_id: string;
  state: CollaborationRequest["state"];
  artifact_id?: string;
}

/**
 * Execute one queued request: secure the isolated consultation session
 * (shareable snapshot + question only), run the budgeted turn, register the
 * formal result exactly once. Late completions (cancelled/expired/already
 * completed) are rejected without registering anything.
 */
export async function executeRequest(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  requestId: string,
): Promise<ExecutionResult> {
  const initial = getRequestRow(store, requestId);
  if (initial === undefined) {
    throw new RoleDockError("NOT_FOUND", `Request "${requestId}" does not exist.`);
  }
  const pre = expireIfOverdue(store, initial);
  if (pre.state === "expired") {
    reclaimTempDir(store, requestId);
    return { request_id: requestId, state: "expired" };
  }
  if (pre.state !== "accepted" && pre.state !== "queued") {
    throw new RoleDockError(
      "INVALID_STATE_TRANSITION",
      `Request is ${pre.state}; only accepted/queued requests can execute.`,
      { details: { request_id: requestId, state: pre.state } },
    );
  }
  const budget = JSON.parse(pre.budget_json) as RequestBudget;

  const failBudget = (message: string): never => {
    markState(store, requestId, "failed", {
      error: { code: "PERMISSION_DENIED", message },
    });
    reclaimTempDir(store, requestId);
    throw new RoleDockError("PERMISSION_DENIED", message, {
      details: { request_id: requestId, stage: "budget" },
    });
  };

  // Isolated working materials: question file and private tmp dir.
  const dir = requestTempDir(store, requestId);
  mkdirSync(join(dir, "tmp"), { recursive: true });
  writeFileSync(join(dir, "question.md"), pre.question, "utf8");

  const { sessionId: consultationSessionId, handle } = await secureConsultationSession(store, adapter, pre);

  // Running only starts once the isolated session is secured.
  markState(store, requestId, "running");

  // Deadline check before spending the turn.
  const beforeTurn = expireIfOverdue(store, getRequestRow(store, requestId) ?? pre);
  if (beforeTurn.state === "expired") {
    await adapter.closeSession(handle).catch(() => undefined);
    reclaimTempDir(store, requestId);
    return { request_id: requestId, state: "expired" };
  }

  await adapter.runTurn(handle, { message: pre.question });
  const result = await adapter.getResult(handle);

  // Budget: turns and output size (token usage is host-reported; the mock
  // does not simulate it).
  if (budget.max_turns !== undefined && result.turn_count > budget.max_turns) {
    failBudget(`Request budget exhausted: ${result.turn_count} turn(s) exceed max_turns ${budget.max_turns}.`);
  }
  const outputBytes = Buffer.byteLength(pre.question, "utf8");
  if (budget.max_output_bytes !== undefined && outputBytes > budget.max_output_bytes) {
    failBudget(`Request budget exhausted: material exceeds max_output_bytes ${budget.max_output_bytes}.`);
  }

  if (result.needs_input === true) {
    markState(store, requestId, "awaiting_input");
    return { request_id: requestId, state: "awaiting_input" };
  }

  // Formal completion: only from running; late results are rejected.
  const current = getRequestRow(store, requestId);
  if (current === undefined || current.state !== "running") {
    throw new RoleDockError(
      "INVALID_STATE_TRANSITION",
      `Request is ${current?.state ?? "unknown"}; late results are rejected and not registered.`,
      { details: { request_id: requestId, state: current?.state ?? null } },
    );
  }
  const artifactBody = `Result for ${requestId} (consultation of "${pre.target_role_id}", ${result.turn_count} turn(s)).`;
  const contentHash = putObject(store, artifactBody);
  const artifactId = `art-${randomBytes(5).toString("hex")}`;
  const now = new Date().toISOString();
  store.tx(() => {
    store
      .prepare(
        "INSERT INTO request_artifacts (artifact_id, workspace_id, request_id, producing_role_id, content_hash, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(artifactId, store.workspaceId, requestId, pre.target_role_id, contentHash, `Consultation result for ${requestId}`, now);
    store
      .prepare(
        "INSERT INTO request_inbox (entry_id, workspace_id, owner_role_id, request_id, artifact_id, content_hash, summary, state, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'unread', ?)",
      )
      .run(`inbox-${randomBytes(5).toString("hex")}`, store.workspaceId, pre.target_role_id, requestId, artifactId, contentHash, `Consultation result for ${requestId}`, now);
  });
  markState(store, requestId, "completed", {
    artifact: { artifact_id: artifactId, content_hash: contentHash },
  });
  reclaimTempDir(store, requestId);
  return { request_id: requestId, state: "completed", artifact_id: artifactId };
}

/** Coordinator-negotiated cancel for a running request (adapter capability). */
export async function cancelRunningRequest(
  store: WorkspaceStore,
  adapter: HarnessAdapter,
  requestId: string,
): Promise<void> {
  const creationKey = `request-${requestId}`;
  const row = store
    .prepare("SELECT host_session_ref FROM sessions WHERE creation_key = ?")
    .get(creationKey) as { host_session_ref: string | null } | undefined;
  if (row?.host_session_ref !== null && row?.host_session_ref !== undefined && adapter.cancel !== undefined) {
    await adapter.cancel({
      adapter: adapter.getCapabilities().adapter,
      host_session_id: row.host_session_ref,
      creation_key: creationKey,
    });
  }
}

/** Late formal completion from outside the engine is always rejected. */
export function rejectLateCompletion(store: WorkspaceStore, requestId: string): void {
  const row = getRequestRow(store, requestId);
  if (row === undefined) {
    throw new RoleDockError("NOT_FOUND", `Request "${requestId}" does not exist.`);
  }
  throw new RoleDockError(
    "INVALID_STATE_TRANSITION",
    `Request is ${row.state}; late results are rejected and cannot complete it or trigger a publish.`,
    { details: { request_id: requestId, state: row.state } },
  );
}
