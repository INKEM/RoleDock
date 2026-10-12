import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { RoleDockError } from "@roledock/protocol";
import type { RolePack } from "@roledock/protocol";
import { existingRoleIds, getPack, listRoleRows } from "../store/queries.js";
import type { WorkspaceStore } from "../store/workspace.js";
import { loadRolePack } from "./loader.js";
import type { LoadedRolePack } from "./loader.js";

export interface InstallRequest {
  /** Directory containing rolepack.json. */
  sourcePath: string;
  /** Must match the opened workspace when provided. */
  workspaceId?: string;
}

export interface InstalledRole {
  id: string;
  title: string;
  initialized: false;
}

export interface InstallResult {
  pack: {
    name: string;
    version: string;
    content_hash: string;
  };
  roles: InstalledRole[];
  /** True when the pack was already installed with identical content. */
  reinstalled: boolean;
  /**
   * True on reinstalled results whose stored content directory was missing
   * (crash between database commit and content promotion, or external
   * deletion) and was restored from the verified source pack.
   */
  content_repaired: boolean;
}

export function checkWorkspaceId(store: WorkspaceStore, provided?: string): void {
  if (provided !== undefined && provided !== store.workspaceId) {
    throw new RoleDockError(
      "VALIDATION_FAILED",
      `Workspace id mismatch: this coordinator operates on ${store.workspaceId}, not ${provided}.`,
      { details: { expected: store.workspaceId, provided } },
    );
  }
}

function copyTree(sourceRoot: string, targetRoot: string, files: LoadedRolePack["files"]): void {
  for (const file of files) {
    const target = join(targetRoot, file.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.absolutePath, target);
  }
}

function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of staging content; absence matters more than the error.
  }
}

function contentMarkerPath(store: WorkspaceStore, name: string, version: string): string {
  return join(store.packsDir, name, version, "rolepack.json");
}

/** Copy the loaded pack into a fresh staging directory; returns its path. */
function copyToStaging(store: WorkspaceStore, loaded: LoadedRolePack): string {
  const stagingDir = join(store.packsDir, store.newStagingDirName());
  mkdirSync(stagingDir, { recursive: true });
  try {
    copyTree(loaded.packRoot, stagingDir, loaded.files);
  } catch (error) {
    removeTree(stagingDir);
    throw error;
  }
  return stagingDir;
}

/** Atomically move a staging directory to packs/<name>/<version>. */
function promoteStaging(store: WorkspaceStore, loaded: LoadedRolePack, stagingDir: string): void {
  const finalDir = join(store.packsDir, loaded.manifest.name, loaded.manifest.version);
  try {
    mkdirSync(dirname(finalDir), { recursive: true });
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(stagingDir, finalDir);
  } catch (error) {
    removeTree(stagingDir);
    throw error;
  }
}

function insertPack(store: WorkspaceStore, loaded: LoadedRolePack, sourcePath: string, now: string): void {
  store
    .prepare(
      `INSERT INTO role_packs (name, version, content_hash, protocol_version, source_path, store_path, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      loaded.manifest.name,
      loaded.manifest.version,
      loaded.contentHash,
      loaded.manifest.requires_protocol,
      sourcePath,
      join(loaded.manifest.name, loaded.manifest.version),
      now,
    );
  for (const role of loaded.manifest.roles) {
    store
      .prepare(
        `INSERT INTO roles (role_id, pack_name, pack_version, title, instructions, definition_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        role.id,
        loaded.manifest.name,
        loaded.manifest.version,
        role.title,
        role.instructions,
        JSON.stringify(role),
      );
    // Uninitialized primary pointer: generation 0, no instance. It becomes
    // generation 1 when the role is first opened (P3, sessions.open).
    store
      .prepare(
        `INSERT INTO role_heads (role_id, generation, knowledge_revision, current_instance_id, updated_at)
         VALUES (?, 0, 0, NULL, ?)`,
      )
      .run(role.id, now);
  }
}

/**
 * Install a local role pack into the workspace: validate, copy content via a
 * staging directory, register pack/roles/uninitialized heads in one
 * transaction, then promote the staging copy. Any failure removes the
 * staging copy and leaves no database rows — a rollback never leaves a
 * half-installed pack.
 */
export function installRolePack(store: WorkspaceStore, request: InstallRequest): InstallResult {
  checkWorkspaceId(store, request.workspaceId);
  const loaded = loadRolePack(request.sourcePath);
  const manifest: RolePack = loaded.manifest;
  const now = new Date().toISOString();

  const existingPack = store.tx(() => getPack(store, manifest.name, manifest.version));
  if (existingPack !== undefined) {
    if (existingPack.content_hash === loaded.contentHash) {
      const roles = listRoleRows(store)
        .filter((role) => role.pack_name === manifest.name && role.pack_version === manifest.version)
        .map((role) => ({ id: role.role_id, title: role.title, initialized: false as const }));

      // Identical reinstall must leave rows and content consistent: a crash
      // between the database commit and content promotion (or external
      // deletion) can leave rows whose content directory is gone. Verify the
      // stored content and restore it from the verified source when missing.
      let contentRepaired = false;
      if (!existsSync(contentMarkerPath(store, manifest.name, manifest.version))) {
        try {
          promoteStaging(store, loaded, copyToStaging(store, loaded));
        } catch (error) {
          throw new RoleDockError(
            "INTERNAL",
            `Failed to restore missing content for ${manifest.name}@${manifest.version}: ${(error as Error).message}`,
          );
        }
        contentRepaired = true;
      }

      return {
        pack: {
          name: existingPack.name,
          version: existingPack.version,
          content_hash: existingPack.content_hash,
        },
        roles,
        reinstalled: true,
        content_repaired: contentRepaired,
      };
    }
    throw new RoleDockError(
      "IDEMPOTENCY_CONFLICT",
      `Pack ${manifest.name}@${manifest.version} is already installed with different content; use a new version for changed content.`,
      { details: { existing_content_hash: existingPack.content_hash, new_content_hash: loaded.contentHash } },
    );
  }

  const conflicts = store.tx(() =>
    existingRoleIds(store, manifest.roles.map((role) => role.id)),
  );
  if (conflicts.size > 0) {
    throw new RoleDockError(
      "ROLE_ALREADY_EXISTS",
      `Role id(s) already registered in this workspace: ${[...conflicts].sort().join(", ")}. Resolve explicitly; roles are never silently overwritten.`,
      { details: { role_ids: [...conflicts].sort(), pack: `${manifest.name}@${manifest.version}` } },
    );
  }

  const stagingDir = copyToStaging(store, loaded);
  try {
    store.tx(() => insertPack(store, loaded, request.sourcePath, now));
  } catch (error) {
    removeTree(stagingDir);
    throw error;
  }

  try {
    promoteStaging(store, loaded, stagingDir);
  } catch (error) {
    throw new RoleDockError(
      "INTERNAL",
      `Failed to store installed pack content: ${(error as Error).message}`,
    );
  }

  return {
    pack: { name: manifest.name, version: manifest.version, content_hash: loaded.contentHash },
    roles: manifest.roles.map((role) => ({ id: role.id, title: role.title, initialized: false })),
    reinstalled: false,
    content_repaired: false,
  };
}
