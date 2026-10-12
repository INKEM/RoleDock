import type { WorkspaceStore } from "./workspace.js";

export interface PackRow {
  name: string;
  version: string;
  content_hash: string;
  protocol_version: string;
  source_path: string;
  store_path: string;
  installed_at: string;
}

export function getPack(store: WorkspaceStore, name: string, version: string): PackRow | undefined {
  return store
    .prepare("SELECT * FROM role_packs WHERE name = ? AND version = ?")
    .get(name, version) as PackRow | undefined;
}

export function listPacks(store: WorkspaceStore): PackRow[] {
  return store.prepare("SELECT * FROM role_packs ORDER BY name, version").all() as unknown as PackRow[];
}

export interface RoleRow {
  role_id: string;
  pack_name: string;
  pack_version: string;
  title: string;
  instructions: string;
  definition_json: string;
}

export function listRoleRows(store: WorkspaceStore): RoleRow[] {
  return store.prepare("SELECT * FROM roles ORDER BY role_id").all() as unknown as RoleRow[];
}

export function getRoleRow(store: WorkspaceStore, roleId: string): RoleRow | undefined {
  return store.prepare("SELECT * FROM roles WHERE role_id = ?").get(roleId) as RoleRow | undefined;
}

/** Which of the given role ids are already registered in this workspace. */
export function existingRoleIds(store: WorkspaceStore, roleIds: readonly string[]): Set<string> {
  const found = new Set<string>();
  const statement = store.prepare("SELECT role_id FROM roles WHERE role_id = ?");
  for (const roleId of roleIds) {
    if (statement.get(roleId) !== undefined) found.add(roleId);
  }
  return found;
}

export interface HeadRow {
  role_id: string;
  generation: number;
  knowledge_revision: number;
  current_instance_id: string | null;
  updated_at: string;
}

export function getHead(store: WorkspaceStore, roleId: string): HeadRow | undefined {
  return store.prepare("SELECT * FROM role_heads WHERE role_id = ?").get(roleId) as
    | HeadRow
    | undefined;
}
