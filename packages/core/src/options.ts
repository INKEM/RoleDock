import type { HarnessAdapter } from "./ports/adapter.js";

/** Options for opening a workspace handle (Coordinator or WorkspaceAdmin). */
export interface HandleOptions {
  /** Workspace root directory. */
  root: string;
  /** When provided, must match the id of the workspace being opened. */
  workspaceId?: string;
  /**
   * Harness adapter for session operations (sessions.open/resume,
   * handoffs.activate). The core never constructs hosts itself; the caller
   * injects one (e.g. the mock adapter, or a real harness bridge in P5).
   */
  adapter?: HarnessAdapter;
}
