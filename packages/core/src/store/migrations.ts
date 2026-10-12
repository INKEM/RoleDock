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
