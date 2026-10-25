import { join } from "node:path";
import type { RoleMaterials, DocumentMaterials } from "@roledock/protocol";
import { RoleDockError } from "@roledock/protocol";
import { getPack, getRoleRow } from "../store/queries.js";
import type { WorkspaceStore } from "../store/workspace.js";
import { loadRolePack, schemaClosureFiles } from "../roles/loader.js";
import { readConfined } from "../files.js";
import { bodyHash, readObject } from "../store/objects.js";

export interface SnapshotEntry { document_key: string; revision: number; content_hash: string }

/** Verified, fixed pack materials, with no host history or executable handles. */
export function roleMaterial(store: WorkspaceStore, roleId: string): RoleMaterials {
  const role = getRoleRow(store, roleId);
  if (!role) throw new RoleDockError("NOT_FOUND", "Role is not installed.");
  const pack = getPack(store, role.pack_name, role.pack_version)!;
  const packRoot = join(store.packsDir, pack.store_path);
  const loaded = loadRolePack(packRoot);
  if (loaded.contentHash !== pack.content_hash) throw new RoleDockError("VALIDATION_FAILED", "Installed role materials changed.");
  const definition = loaded.manifest.roles.find((item) => item.id === roleId)!;
  return {
    package_name: pack.name, package_version: pack.version, content_hash: pack.content_hash,
    definition,
    instructions: readConfined(packRoot, definition.instructions).toString("utf8"),
    templates: (definition.documents ?? []).map((doc) => ({ key: doc.key, body: readConfined(packRoot, doc.template).toString("utf8") })),
    // All validated JSON materials accompany local schema references, so the
    // host never needs unrestricted filesystem access to resolve them.
    schemas: [...new Set((definition.output_schemas ?? []).flatMap((schema) => schemaClosureFiles(packRoot, schema.schema)))]
      .map((file) => ({ file, body: readConfined(packRoot, file).toString("utf8") })),
  };
}

export function documentMaterial(store: WorkspaceStore, roleId: string, entries: SnapshotEntry[], shareOnly: boolean): DocumentMaterials[] {
  return entries.flatMap((entry) => {
    const revision = store.prepare("SELECT visibility, content_hash, created_by_instance_id, created_at FROM document_revisions WHERE role_id = ? AND document_key = ? AND revision = ?")
      .get(roleId, entry.document_key, entry.revision) as { visibility: "private" | "role" | "project" | "public"; content_hash: string; created_by_instance_id: string | null; created_at: string } | undefined;
    if (!revision || revision.content_hash !== entry.content_hash) throw new RoleDockError("VALIDATION_FAILED", "Invalid knowledge snapshot reference.");
    if (revision.visibility === "private" || (shareOnly && revision.visibility === "role")) return [];
    const body = readObject(store, entry.content_hash);
    if (bodyHash(body) !== entry.content_hash) throw new RoleDockError("VALIDATION_FAILED", "Knowledge body hash mismatch.");
    return [{ ...entry, ...revision, visibility: revision.visibility, owner_role_id: roleId, body }];
  });
}
