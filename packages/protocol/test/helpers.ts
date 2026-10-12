import type {
  BootstrapBundle,
  Checkpoint,
  CollaborationRequest,
  DocumentRevision,
  RoleHead,
  RolePack,
} from "../src/index.js";

export const TS = "2026-10-12T00:00:00Z";
export const HASH = "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8";
export const HASH2 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

/** Minimal legal role pack; spread overrides to build variants. */
export function rolePack(overrides: Partial<RolePack> = {}): RolePack {
  return {
    schema_version: "0.1",
    name: "demo-pack",
    version: "0.1.0",
    requires_protocol: "0.1",
    roles: [
      {
        id: "alpha",
        title: "Alpha",
        instructions: "roles/alpha.md",
      },
    ],
    ...overrides,
  };
}

export function roleHead(overrides: Partial<RoleHead> = {}): RoleHead {
  return {
    workspace_id: "ws-main",
    role_id: "alpha",
    generation: 1,
    knowledge_revision: 0,
    current_instance_id: "inst-alpha-1",
    role_contract: {
      package_name: "demo-pack",
      package_version: "0.1.0",
      content_hash: HASH,
    },
    updated_at: TS,
    ...overrides,
  };
}

export function documentRevision(overrides: Partial<DocumentRevision> = {}): DocumentRevision {
  return {
    workspace_id: "ws-main",
    role_id: "alpha",
    document_key: "state",
    revision: 1,
    content_hash: HASH,
    visibility: "project",
    created_by_instance_id: "inst-alpha-1",
    created_at: TS,
    ...overrides,
  };
}

export function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    checkpoint_id: "ckpt-alpha-1",
    workspace_id: "ws-main",
    role_id: "alpha",
    generation: 1,
    knowledge_revision: 3,
    document_snapshots: [
      { document_key: "state", revision: 2, content_hash: HASH },
    ],
    handoff_summary: {
      format: "markdown",
      body: "# Handoff\n\nContext and open threads.",
      content_hash: HASH2,
    },
    todos: [{ description: "Confirm baseline", done: false }],
    sources: [{ kind: "document", document_key: "state", revision: 2 }],
    created_by_instance_id: "inst-alpha-1",
    created_at: TS,
    ...overrides,
  };
}

export function bootstrapBundle(overrides: Partial<BootstrapBundle> = {}): BootstrapBundle {
  return {
    bundle_id: "bundle-alpha-2",
    protocol_version: "0.1",
    workspace_id: "ws-main",
    role_id: "alpha",
    source_generation: 1,
    source_knowledge_revision: 3,
    role_contract: {
      package_name: "demo-pack",
      package_version: "0.1.0",
      content_hash: HASH,
    },
    checkpoint: { checkpoint_id: "ckpt-alpha-1", content_hash: HASH2 },
    created_by_instance_id: "inst-alpha-1",
    created_at: TS,
    ...overrides,
  };
}

export function collaborationRequest(
  overrides: Partial<CollaborationRequest> = {},
): CollaborationRequest {
  return {
    request_id: "req-0001",
    workspace_id: "ws-main",
    idempotency_key: "idem-001",
    initiating: {
      session_id: "sess-beta-1",
      instance_id: "inst-beta-1",
      role_id: "beta",
    },
    target_role_id: "alpha",
    binding: { target_generation: 1, knowledge_revision: 3 },
    state: "accepted",
    read_receipts: [{ document_key: "state", revision: 2 }],
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}
