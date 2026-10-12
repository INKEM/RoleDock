/** Options for opening a workspace handle (Coordinator or WorkspaceAdmin). */
export interface HandleOptions {
  /** Workspace root directory. */
  root: string;
  /** When provided, must match the id of the workspace being opened. */
  workspaceId?: string;
}
