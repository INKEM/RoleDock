import { RoleDockError } from "@roledock/protocol";
import { getPack, getRoleRow, getHead, listRoleRows } from "../store/queries.js";
import type { WorkspaceStore } from "../store/workspace.js";

export interface RoleSummary {
  role_id: string;
  title: string;
  pack: {
    name: string;
    version: string;
    content_hash: string;
  };
  initialized: boolean;
  generation: number;
  knowledge_revision: number;
  requested_capabilities: string[];
  granted_capabilities: string[];
}

export interface RoleResolution extends RoleSummary {
  current_instance_id: string | null;
}

export function summarizeRoles(store: WorkspaceStore): RoleSummary[] {
  const packs = new Map<string, { name: string; version: string; content_hash: string }>();
  const grants = store.getConfig().policy.grants;
  return listRoleRows(store).map((row) => {
    const packKey = `${row.pack_name}@${row.pack_version}`;
    let pack = packs.get(packKey);
    if (pack === undefined) {
      const packRow = getPack(store, row.pack_name, row.pack_version);
      if (packRow === undefined) {
        throw new RoleDockError(
          "INTERNAL",
          `Role ${row.role_id} references missing pack ${packKey}.`,
        );
      }
      pack = { name: packRow.name, version: packRow.version, content_hash: packRow.content_hash };
      packs.set(packKey, pack);
    }
    const head = getHead(store, row.role_id);
    const definition = JSON.parse(row.definition_json) as { requested_capabilities?: string[] };
    const granted = grants[row.role_id] ?? [];
    return {
      role_id: row.role_id,
      title: row.title,
      pack,
      initialized: (head?.generation ?? 0) > 0,
      generation: head?.generation ?? 0,
      knowledge_revision: head?.knowledge_revision ?? 0,
      requested_capabilities: definition.requested_capabilities ?? [],
      granted_capabilities: [...granted],
    };
  });
}

export function resolveRoleRecord(store: WorkspaceStore, roleId: string): RoleResolution {
  const row = getRoleRow(store, roleId);
  if (row === undefined) {
    throw new RoleDockError("NOT_FOUND", `Role "${roleId}" is not installed in this workspace.`, {
      details: { role_id: roleId },
    });
  }
  const summary = summarizeRoles(store).find((candidate) => candidate.role_id === roleId);
  if (summary === undefined) {
    throw new RoleDockError("INTERNAL", `Role ${roleId} found but could not be summarized.`);
  }
  return { ...summary, current_instance_id: getHead(store, roleId)?.current_instance_id ?? null };
}
