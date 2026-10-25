import type { WorkspaceStore } from "../../packages/core/src/store/workspace.js";
/** Explicit owner policy setup for tests whose subject is another invariant. */
export function grantFixtureCapabilities(store: WorkspaceStore): void {
  const config = store.getConfig();
  const roles = store.prepare("SELECT role_id FROM roles").all() as { role_id: string }[];
  for (const { role_id } of roles) config.policy.grants[role_id] = [
    "documents.read", "documents.propose", "documents.publish", "requests.create", "requests.execute",
    "requests.read", "requests.reply", "requests.cancel", "artifacts.read",
  ];
  store.setConfig(config);
}
