import { RoleDockError } from "@roledock/protocol";

/**
 * Options for constructing a Coordinator. P0 fixes the shape; storage and
 * policy loading arrive with the phases that implement them.
 */
export interface CoordinatorOptions {
  /** Workspace root directory holding state and the content-addressed output area. */
  root: string;
}

const SPEC = "docs/spec/sdk-operations.md";

function notImplemented(operation: string): RoleDockError {
  return new RoleDockError(
    "NOT_IMPLEMENTED",
    `Operation "${operation}" is specified but not implemented in this build (P0 contracts only). See ${SPEC}.`,
    { details: { operation, spec: SPEC } },
  );
}

/**
 * The RoleDock coordinator: single writer per workspace (ADR-0001).
 *
 * P0 fixes this operation surface and its failure contract. Every method
 * rejects with a NOT_IMPLEMENTED RoleDockError until its delivery phase;
 * none of them may fake success. Signatures widen in the implementing
 * phases; operation contracts live in docs/spec/sdk-operations.md.
 */
export class Coordinator {
  constructor(readonly options: CoordinatorOptions) {}

  // -- roles ---------------------------------------------------------------
  async installRolePack(_input: unknown): Promise<never> {
    throw notImplemented("roles.install");
  }
  async listRoles(_input: unknown): Promise<never> {
    throw notImplemented("roles.list");
  }
  async resolveRole(_input: unknown): Promise<never> {
    throw notImplemented("roles.resolve");
  }

  // -- sessions --------------------------------------------------------------
  async openSession(_input: unknown): Promise<never> {
    throw notImplemented("sessions.open");
  }
  async resumeSession(_input: unknown): Promise<never> {
    throw notImplemented("sessions.resume");
  }

  // -- documents -------------------------------------------------------------
  async listDocuments(_input: unknown): Promise<never> {
    throw notImplemented("documents.list");
  }
  async readDocument(_input: unknown): Promise<never> {
    throw notImplemented("documents.read");
  }
  async proposeDocumentUpdate(_input: unknown): Promise<never> {
    throw notImplemented("documents.propose");
  }
  async publishDocument(_input: unknown): Promise<never> {
    throw notImplemented("documents.publish");
  }

  // -- handoffs --------------------------------------------------------------
  async prepareHandoff(_input: unknown): Promise<never> {
    throw notImplemented("handoffs.prepare");
  }
  async activateHandoff(_input: unknown): Promise<never> {
    throw notImplemented("handoffs.activate");
  }

  // -- requests --------------------------------------------------------------
  async createRequest(_input: unknown): Promise<never> {
    throw notImplemented("requests.create");
  }
  async getRequest(_input: unknown): Promise<never> {
    throw notImplemented("requests.get");
  }
  async replyToRequest(_input: unknown): Promise<never> {
    throw notImplemented("requests.reply");
  }
  async cancelRequest(_input: unknown): Promise<never> {
    throw notImplemented("requests.cancel");
  }

  // -- artifacts ---------------------------------------------------------------
  async readArtifact(_input: unknown): Promise<never> {
    throw notImplemented("artifacts.read");
  }

  // -- knowledge ---------------------------------------------------------------
  async exportKnowledge(_input: unknown): Promise<never> {
    throw notImplemented("knowledge.export");
  }
  async importKnowledge(_input: unknown): Promise<never> {
    throw notImplemented("knowledge.import");
  }
}

/** All SDK operation names, derived from the Coordinator surface itself. */
export function coordinatorOperations(): string[] {
  const proto = Coordinator.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor" && typeof proto[name] === "function")
    .sort();
}
