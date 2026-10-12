import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoleDockError } from "@roledock/protocol";
import { runMigrations } from "./migrations.js";

export interface WorkspaceStoreOptions {
  /** Workspace root directory; state lives under `<root>/.roledock/`. */
  root: string;
}

/** SQLITE_BUSY / SQLITE_LOCKED result codes reported by node:sqlite as errcode. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    ((error as { errcode?: unknown }).errcode === SQLITE_BUSY ||
      (error as { errcode?: unknown }).errcode === SQLITE_LOCKED)
  );
}

export function mapWorkspaceError(error: unknown, root: string): unknown {
  if (isSqliteBusy(error)) {
    return new RoleDockError(
      "WORKSPACE_LOCKED",
      `Another coordinator already holds the workspace at ${root}; only one coordinator may write a workspace.`,
      { details: { root } },
    );
  }
  return error;
}

const DEFAULT_CONFIG = JSON.stringify({ policy: { grants: {} } });

export interface WorkspaceConfig {
  policy: {
    grants: Record<string, string[]>;
  };
}

/**
 * Transactional state store for one workspace (ADR-0001).
 *
 * Opening takes the workspace file lock: the connection runs in exclusive
 * locking mode and holds it until close(). A second WorkspaceStore — same
 * process or not — fails its first statement with SQLITE_BUSY, mapped to
 * WORKSPACE_LOCKED. The lock is released by the OS if the process dies, so
 * there are no stale locks to clean up.
 */
export class WorkspaceStore {
  private constructor(
    readonly root: string,
    readonly workspaceId: string,
    private readonly db: DatabaseSync,
    private readonly stateDir: string,
  ) {}

  static open(options: WorkspaceStoreOptions): WorkspaceStore {
    const stateDir = join(options.root, ".roledock");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(stateDir, "packs"), { recursive: true });

    const db = new DatabaseSync(join(stateDir, "state.sqlite"), { timeout: 0 });
    try {
      // Locking is lazy in SQLite: setting the pragma alone does not take
      // the file lock. runMigrations reads/writes the database, which takes
      // the exclusive lock here and holds it until close().
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      runMigrations(db);

      const row = db.prepare("SELECT id FROM workspace LIMIT 1").get() as
        | { id: string }
        | undefined;
      let workspaceId: string;
      if (row === undefined) {
        workspaceId = `ws-${randomBytes(4).toString("hex")}`;
        db.prepare("INSERT INTO workspace (id, created_at, config_json) VALUES (?, ?, ?)").run(
          workspaceId,
          new Date().toISOString(),
          DEFAULT_CONFIG,
        );
      } else {
        workspaceId = row.id;
      }
      return new WorkspaceStore(options.root, workspaceId, db, stateDir);
    } catch (error) {
      db.close();
      throw mapWorkspaceError(error, options.root);
    }
  }

  /** Run fn atomically; any throw rolls the transaction back and rethrows. */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A failed transaction is rolled back automatically; nothing to do.
      }
      throw error;
    }
  }

  prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
    return this.db.prepare(sql);
  }

  getConfig(): WorkspaceConfig {
    const row = this.db.prepare("SELECT config_json FROM workspace LIMIT 1").get() as {
      config_json: string;
    };
    return JSON.parse(row.config_json) as WorkspaceConfig;
  }

  /** Replace the stored config inside a transaction; call within store.tx(). */
  setConfig(config: WorkspaceConfig): void {
    this.db
      .prepare("UPDATE workspace SET config_json = ? WHERE id = ?")
      .run(JSON.stringify(config), this.workspaceId);
  }

  get packsDir(): string {
    return join(this.stateDir, "packs");
  }

  newStagingDirName(): string {
    return `.staging-${randomUUID()}`;
  }

  close(): void {
    this.db.close();
  }
}
