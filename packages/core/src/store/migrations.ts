import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RoleDockError } from "@roledock/protocol";

/**
 * Checksummed, strictly ordered migrations. Applying is idempotent; a
 * recorded checksum that no longer matches this build (tampered or edited
 * history) is rejected instead of silently continuing. State written by a
 * newer build (unknown migration ids) is rejected as well.
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial-state",
    statements: [
      `CREATE TABLE workspace (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        config_json TEXT NOT NULL
      )`,
      `CREATE TABLE role_packs (
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        protocol_version TEXT NOT NULL,
        source_path TEXT NOT NULL,
        store_path TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        PRIMARY KEY (name, version)
      )`,
      `CREATE TABLE roles (
        role_id TEXT PRIMARY KEY,
        pack_name TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        FOREIGN KEY (pack_name, pack_version) REFERENCES role_packs(name, version)
      )`,
      `CREATE TABLE role_heads (
        role_id TEXT PRIMARY KEY REFERENCES roles(role_id),
        generation INTEGER NOT NULL DEFAULT 0,
        knowledge_revision INTEGER NOT NULL DEFAULT 0,
        current_instance_id TEXT,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE agent_instances (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL REFERENCES roles(role_id),
        generation INTEGER NOT NULL,
        predecessor_instance_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('primary', 'request')),
        adapter TEXT NOT NULL,
        state TEXT NOT NULL,
        role_id TEXT,
        instance_id TEXT,
        host_session_ref TEXT,
        creation_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE documents (
        workspace_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        document_key TEXT NOT NULL,
        latest_revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, role_id, document_key)
      )`,
      `CREATE TABLE document_revisions (
        workspace_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        document_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('project', 'role', 'private')),
        created_by_instance_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, role_id, document_key, revision)
      )`,
      `CREATE TABLE idempotency_keys (
        workspace_id TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, idem_key)
      )`,
      `CREATE TABLE outbox_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
        created_at TEXT NOT NULL,
        completed_at TEXT
      )`,
    ],
  },
  {
    id: 2,
    name: "documents-knowledge",
    statements: [
      // P2 widens the visibility ladder with "public"; SQLite cannot alter a
      // CHECK constraint, so document_revisions is rebuilt and backfilled.
      `CREATE TABLE document_revisions_new (
        workspace_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        document_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('private', 'role', 'project', 'public')),
        created_by_instance_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, role_id, document_key, revision)
      )`,
      `INSERT INTO document_revisions_new SELECT * FROM document_revisions`,
      `DROP TABLE document_revisions`,
      `ALTER TABLE document_revisions_new RENAME TO document_revisions`,
      `CREATE TABLE read_receipts (
        receipt_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        instance_id TEXT,
        reader_role_id TEXT NOT NULL,
        owner_role_id TEXT NOT NULL,
        document_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        read_at TEXT NOT NULL
      )`,
      `CREATE TABLE candidate_updates (
        candidate_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_role_id TEXT NOT NULL,
        document_key TEXT NOT NULL,
        baseline_revision INTEGER NOT NULL,
        proposed_body_hash TEXT NOT NULL,
        note TEXT,
        proposed_by_session_id TEXT NOT NULL,
        proposed_by_role_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('documents.propose', 'knowledge.import')),
        state TEXT NOT NULL CHECK (state IN ('open', 'adopted', 'superseded', 'rejected')),
        adopted_revision INTEGER,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
      `CREATE TABLE checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        knowledge_revision INTEGER NOT NULL,
        document_snapshots_json TEXT NOT NULL,
        handoff_summary_json TEXT NOT NULL,
        user_decision_refs_json TEXT,
        todos_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        created_by_instance_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    id: 3,
    name: "sessions-handoff",
    statements: [
      // P3 marks handoff predecessors as "superseded" (they lost formal
      // publish rights); SQLite cannot alter a CHECK, so agent_instances is
      // rebuilt and backfilled.
      `CREATE TABLE agent_instances_new (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL REFERENCES roles(role_id),
        generation INTEGER NOT NULL,
        predecessor_instance_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'superseded')),
        created_at TEXT NOT NULL
      )`,
      `INSERT INTO agent_instances_new SELECT * FROM agent_instances`,
      `DROP TABLE agent_instances`,
      `ALTER TABLE agent_instances_new RENAME TO agent_instances`,
      `CREATE TABLE bootstrap_bundles (
        bundle_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        source_generation INTEGER NOT NULL,
        source_knowledge_revision INTEGER NOT NULL,
        checkpoint_id TEXT NOT NULL,
        checkpoint_hash TEXT NOT NULL,
        contract_package_name TEXT NOT NULL,
        contract_package_version TEXT NOT NULL,
        contract_content_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'provisioned', 'activated', 'abandoned')),
        provisioned_host_session TEXT,
        creation_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        activated_at TEXT
      )`,
    ],
  },
  {
    id: 4,
    name: "collaboration-requests",
    statements: [
      `CREATE TABLE requests (
        request_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        idem_content_hash TEXT NOT NULL,
        initiating_session_id TEXT NOT NULL,
        initiating_instance_id TEXT NOT NULL,
        initiating_role_id TEXT NOT NULL,
        target_role_id TEXT NOT NULL,
        binding_instance_id TEXT NOT NULL,
        binding_generation INTEGER NOT NULL,
        binding_knowledge_revision INTEGER NOT NULL,
        binding_snapshot_json TEXT NOT NULL,
        binding_contract_version TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        question TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted','queued','running','awaiting_input','completed','failed','cancelled','expired')),
        execution_uncertain INTEGER NOT NULL DEFAULT 0,
        result_artifact_id TEXT,
        result_content_hash TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        UNIQUE (workspace_id, idempotency_key)
      )`,
      `CREATE TABLE request_artifacts (
        artifact_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        producing_role_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        summary TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE request_inbox (
        entry_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        owner_role_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        summary TEXT,
        state TEXT NOT NULL CHECK (state IN ('unread', 'read')),
        delivered_at TEXT NOT NULL,
        read_at TEXT
      )`,
      // P4 binds request results to candidates; widen the source CHECK.
      `CREATE TABLE candidate_updates_new (
        candidate_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        target_role_id TEXT NOT NULL,
        document_key TEXT NOT NULL,
        baseline_revision INTEGER NOT NULL,
        proposed_body_hash TEXT NOT NULL,
        note TEXT,
        proposed_by_session_id TEXT NOT NULL,
        proposed_by_role_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('documents.propose', 'knowledge.import', 'request.result')),
        state TEXT NOT NULL CHECK (state IN ('open', 'adopted', 'superseded', 'rejected')),
        adopted_revision INTEGER,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
      `INSERT INTO candidate_updates_new SELECT * FROM candidate_updates`,
      `DROP TABLE candidate_updates`,
      `ALTER TABLE candidate_updates_new RENAME TO candidate_updates`,
    ],
  },
  {
    id: 5,
    name: "runtime-rework-intents",
    statements: [
      `ALTER TABLE sessions ADD COLUMN capability_scope_json TEXT`,
      `ALTER TABLE sessions ADD COLUMN bootstrap_payload TEXT`,
      `ALTER TABLE sessions ADD COLUMN open_input_hash TEXT`,
      `ALTER TABLE sessions ADD COLUMN open_key TEXT`,
      `CREATE UNIQUE INDEX sessions_open_key ON sessions(open_key) WHERE open_key IS NOT NULL`,
      `ALTER TABLE bootstrap_bundles ADD COLUMN open_input_hash TEXT`,
      `ALTER TABLE bootstrap_bundles ADD COLUMN open_key TEXT`,
      `CREATE UNIQUE INDEX bundles_open_key ON bootstrap_bundles(open_key) WHERE open_key IS NOT NULL`,
      `ALTER TABLE requests ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'pending'`,
      `ALTER TABLE requests ADD COLUMN turns_reserved INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE requests ADD COLUMN turn_key TEXT`,
      `ALTER TABLE requests ADD COLUMN output_bytes_used INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE requests ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE requests ADD COLUMN binding_material_json TEXT`,
      `ALTER TABLE requests ADD COLUMN capability_scope_json TEXT NOT NULL DEFAULT '[]'`,
    ],
  },
  {
    id: 6,
    name: "external-session-authorization-anchor",
    statements: [
      `CREATE TABLE external_sessions (
        external_session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        adapter TEXT NOT NULL, host_session_id TEXT NOT NULL, connection_subject TEXT NOT NULL,
        capability_ceiling_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'connected', created_at TEXT NOT NULL,
        UNIQUE(adapter, host_session_id)
      )`,
      `CREATE TABLE role_authorizations (
        authorization_id TEXT PRIMARY KEY, external_session_id TEXT NOT NULL REFERENCES external_sessions(external_session_id),
        role_id TEXT NOT NULL, record_json TEXT NOT NULL, revoked_at TEXT,
        source_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL
      )`,
      `CREATE TABLE anchor_attempts (
        attempt_id TEXT PRIMARY KEY, external_session_id TEXT NOT NULL REFERENCES external_sessions(external_session_id),
        authorization_id TEXT NOT NULL REFERENCES role_authorizations(authorization_id),
        idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, bundle_hash TEXT NOT NULL, load_key TEXT NOT NULL UNIQUE,
        source_generation INTEGER NOT NULL, source_knowledge_revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','loading','uncertain','active','failed')),
        confirmation_json TEXT, error_json TEXT, created_at TEXT NOT NULL,
        UNIQUE(external_session_id, idempotency_key)
      )`,
      `CREATE UNIQUE INDEX one_pending_anchor ON anchor_attempts(external_session_id)
        WHERE state IN ('prepared','loading','uncertain')`,
      `CREATE TABLE anchor_loads (
        load_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES anchor_attempts(attempt_id),
        bundle_hash TEXT NOT NULL, prepared_at TEXT NOT NULL, confirmation_json TEXT
      )`,
      `CREATE TABLE session_bindings (
        external_session_id TEXT PRIMARY KEY REFERENCES external_sessions(external_session_id),
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id), instance_id TEXT NOT NULL UNIQUE,
        role_id TEXT NOT NULL, generation INTEGER NOT NULL, authorization_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('active','superseded','released','revoked','expired')),
        created_at TEXT NOT NULL
      )`,
      `ALTER TABLE requests ADD COLUMN initiating_authorization_id TEXT`,
      `ALTER TABLE requests ADD COLUMN target_authorization_id TEXT`,
    ],
  },
  {
    id: 7,
    name: "human-authorization-events",
    statements: [
      // B2 (ADR-0011): verbatim records of trusted-entry human confirmations.
      // Written only by the owner face (submitHumanEvent); storage alone
      // grants nothing — recordHuman still validates via the adapter port.
      `CREATE TABLE human_authorization_events (
        workspace_id TEXT NOT NULL,
        external_session_id TEXT NOT NULL REFERENCES external_sessions(external_session_id),
        host_session_id TEXT NOT NULL, connection_subject TEXT NOT NULL,
        event_ref TEXT NOT NULL, actor_id TEXT NOT NULL, role_id TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        inherit TEXT NOT NULL CHECK (inherit IN ('initialize','takeover')),
        expires_at TEXT NOT NULL,
        entry TEXT NOT NULL CHECK (entry IN ('cli-console','gui-confirm')),
        recorded_at TEXT NOT NULL, input_hash TEXT NOT NULL,
        PRIMARY KEY (workspace_id, external_session_id, event_ref)
      )`,
      `CREATE INDEX human_authorization_events_lookup
        ON human_authorization_events(workspace_id, host_session_id, event_ref)`,
    ],
  },
  {
    id: 8,
    name: "observability-timestamps",
    statements: [
      // G4 (desktop-gui-contract §2.3): the owner binding/load read views need
      // observation timestamps — when a material load was confirmed and when a
      // binding entered its current state (release/revocation/expiry time).
      // No backfill: rows written before this column keep NULL rather than a
      // fabricated timestamp.
      `ALTER TABLE anchor_loads ADD COLUMN confirmed_at TEXT`,
      `ALTER TABLE session_bindings ADD COLUMN state_changed_at TEXT`,
    ],
  },
  {
    id: 9,
    name: "request-cleanup-error",
    statements: [
      // G6 (desktop-gui-contract §2.3 requests.listCleanup): a reclamation
      // FAILURE must be distinguishable from completion without changing the
      // terminal state. cleanupRequest records the last failure here and
      // clears it on success; the durable cleanup_pending=1 retry continues.
      `ALTER TABLE requests ADD COLUMN cleanup_error_json TEXT`,
    ],
  },
];

function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(migration.statements.join("\n;\n"))
    .digest("hex");
}

export function runMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Map<number, string>();
  for (const row of db.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id").all()) {
    const { id, checksum } = row as { id: number; checksum: string };
    applied.set(id, checksum);
  }

  const highestKnown = MIGRATIONS[MIGRATIONS.length - 1]?.id ?? 0;
  for (const id of applied.keys()) {
    if (id > highestKnown) {
      throw new RoleDockError(
        "VALIDATION_FAILED",
        `Workspace state contains migration ${id}, which is newer than this build supports.`,
        { details: { migration_id: id, issue: "state written by a newer build" } },
      );
    }
  }

  for (const migration of MIGRATIONS) {
    const recorded = applied.get(migration.id);
    if (recorded !== undefined) {
      if (recorded !== migrationChecksum(migration)) {
        throw new RoleDockError(
          "VALIDATION_FAILED",
          `Migration ${migration.id} checksum mismatch: the recorded history does not match this build.`,
          { details: { migration_id: migration.id, issue: "migration checksum mismatch" } },
        );
      }
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migrationChecksum(migration),
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
