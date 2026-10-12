import type { WorkspaceStore } from "./store/workspace.js";
import type { Coordinator } from "./coordinator.js";
import type { WorkspaceAdmin } from "./admin.js";

/**
 * Module-private registry binding opened handles to their workspace store.
 * Only @roledock/core/testing reaches into this; the public Coordinator and
 * WorkspaceAdmin surfaces expose no accessor, so no permission bypass exists
 * outside the explicitly test-only entry.
 */
const coordinatorStores = new WeakMap<Coordinator, WorkspaceStore>();
const adminStores = new WeakMap<WorkspaceAdmin, WorkspaceStore>();

export function registerCoordinatorStore(coordinator: Coordinator, store: WorkspaceStore): void {
  coordinatorStores.set(coordinator, store);
}

export function coordinatorStore(coordinator: Coordinator): WorkspaceStore {
  const store = coordinatorStores.get(coordinator);
  if (store === undefined) {
    throw new Error("Coordinator store is not registered; use Coordinator.open().");
  }
  return store;
}

export function registerAdminStore(admin: WorkspaceAdmin, store: WorkspaceStore): void {
  adminStores.set(admin, store);
}

export function adminStore(admin: WorkspaceAdmin): WorkspaceStore {
  const store = adminStores.get(admin);
  if (store === undefined) {
    throw new Error("WorkspaceAdmin store is not registered; use WorkspaceAdmin.open().");
  }
  return store;
}
