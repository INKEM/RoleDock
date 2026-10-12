import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";
import type {
  BootstrapBundle,
  Checkpoint,
  CollaborationRequest,
} from "../src/index.js";
import {
  bootstrapBundle,
  collaborationRequest,
  documentRevision,
  roleHead,
  checkpoint,
  HASH,
} from "./helpers.js";

function expectLegal<T>(schema: Parameters<typeof validate>[0], value: unknown): T {
  const result = validate<T>(schema, value);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { ok: true; value: T }).value;
}

function expectIllegal(schema: Parameters<typeof validate>[0], value: unknown, keyword: string) {
  const result = validate(schema, value);
  expect(result.ok, `expected rejection: ${JSON.stringify(value)}`).toBe(false);
  if (!result.ok) {
    expect(
      result.errors.map((e) => e.keyword),
      JSON.stringify(result.errors),
    ).toContain(keyword);
  }
}

describe("role-head schema", () => {
  it("accepts a legal primary pointer", () => {
    expectLegal("role-head", roleHead());
  });

  it("rejects generation below 1", () => {
    expectIllegal("role-head", roleHead({ generation: 0 }), "minimum");
  });

  it("rejects a negative knowledge_revision", () => {
    expectIllegal("role-head", roleHead({ knowledge_revision: -1 }), "minimum");
  });

  it("rejects a malformed content hash in the role contract", () => {
    expectIllegal(
      "role-head",
      roleHead({
        role_contract: {
          package_name: "demo-pack",
          package_version: "0.1.0",
          content_hash: "deadbeef",
        },
      }),
      "pattern",
    );
  });

  it("rejects a missing current_instance_id", () => {
    const head = roleHead();
    delete (head as Partial<typeof head>).current_instance_id;
    expectIllegal("role-head", head, "required");
  });

  it("rejects a non-integer generation", () => {
    expectIllegal("role-head", roleHead({ generation: 1.5 }), "type");
  });
});

describe("document-revision schema", () => {
  it("accepts a legal revision", () => {
    expectLegal("document-revision", documentRevision());
  });

  it("rejects revision 0", () => {
    expectIllegal("document-revision", documentRevision({ revision: 0 }), "minimum");
  });

  it("rejects visibility outside the enum", () => {
    expectIllegal(
      "document-revision",
      documentRevision({ visibility: "public" as unknown as "project" }),
      "enum",
    );
  });

  it("rejects a non-hex content hash", () => {
    expectIllegal(
      "document-revision",
      documentRevision({ content_hash: "ZZ".repeat(32) }),
      "pattern",
    );
  });

  it("rejects unknown properties", () => {
    expectIllegal(
      "document-revision",
      { ...documentRevision(), mutable: true },
      "additionalProperties",
    );
  });
});

describe("checkpoint schema", () => {
  it("accepts a legal checkpoint with todos and sources", () => {
    expectLegal("checkpoint", checkpoint());
  });

  it("accepts optional user decision references", () => {
    expectLegal(
      "checkpoint",
      checkpoint({
        user_decision_refs: [
          { summary: "User approved plan A on 2026-10-01", document_key: "state", revision: 2 },
          { summary: "Verbal decision, no anchor document" },
        ],
      }),
    );
  });

  it("rejects a handoff summary without a body", () => {
    expectIllegal(
      "checkpoint",
      checkpoint({
        handoff_summary: { format: "markdown", content_hash: HASH } as Checkpoint["handoff_summary"],
      }),
      "required",
    );
  });

  it("rejects a todo missing the done flag", () => {
    expectIllegal(
      "checkpoint",
      checkpoint({ todos: [{ description: "half-specified" } as Checkpoint["todos"][number]] }),
      "required",
    );
  });

  it("rejects an unknown source kind", () => {
    expectIllegal(
      "checkpoint",
      checkpoint({
        sources: [{ kind: "rumor" } as unknown as Checkpoint["sources"][number]],
      }),
      "enum",
    );
  });

  it("rejects a snapshot without a content hash", () => {
    expectIllegal(
      "checkpoint",
      checkpoint({
        document_snapshots: [{ document_key: "state", revision: 1 } as Checkpoint["document_snapshots"][number]],
      }),
      "required",
    );
  });
});

describe("bootstrap-bundle schema", () => {
  it("accepts a legal bundle", () => {
    expectLegal("bootstrap-bundle", bootstrapBundle());
  });

  it("accepts a bundle with a provisioned session id", () => {
    expectLegal("bootstrap-bundle", bootstrapBundle({ provisioned_session_id: "sess-new-1" }));
  });

  it("rejects a wrong protocol_version", () => {
    expectIllegal(
      "bootstrap-bundle",
      bootstrapBundle({ protocol_version: "0.2" as unknown as "0.1" }),
      "const",
    );
  });

  it("rejects source_generation 0", () => {
    expectIllegal("bootstrap-bundle", bootstrapBundle({ source_generation: 0 }), "minimum");
  });

  it("rejects a checkpoint reference without a hash", () => {
    expectIllegal(
      "bootstrap-bundle",
      bootstrapBundle({
        checkpoint: { checkpoint_id: "ckpt-alpha-1" } as BootstrapBundle["checkpoint"],
      }),
      "required",
    );
  });
});

describe("collaboration-request schema", () => {
  it("accepts a fresh accepted request with read receipts", () => {
    expectLegal("collaboration-request", collaborationRequest());
  });

  it("accepts a terminal completed request with result and terminal_at", () => {
    expectLegal(
      "collaboration-request",
      collaborationRequest({
        state: "completed",
        result: { artifact_id: "art-0001", content_hash: HASH, summary: "Answered." },
        terminal_at: "2026-10-12T01:00:00Z",
      }),
    );
  });

  it("accepts an execution-uncertain running request with a budget", () => {
    expectLegal(
      "collaboration-request",
      collaborationRequest({
        state: "running",
        execution_uncertain: true,
        budget: { max_turns: 4, deadline: "2026-10-12T02:00:00Z" },
      }),
    );
  });

  it("rejects a state outside the enum", () => {
    expectIllegal(
      "collaboration-request",
      collaborationRequest({ state: "pending" as unknown as "accepted" }),
      "enum",
    );
  });

  it("rejects an unknown error code", () => {
    expectIllegal(
      "collaboration-request",
      collaborationRequest({
        state: "failed",
        error: { code: "SOMETHING_ELSE" as never, message: "boom" },
      }),
      "enum",
    );
  });

  it("rejects a binding without target_generation", () => {
    const request = collaborationRequest();
    delete (request.binding as Partial<typeof request.binding>).target_generation;
    expectIllegal("collaboration-request", request, "required");
  });

  it("rejects an empty idempotency key", () => {
    expectIllegal("collaboration-request", collaborationRequest({ idempotency_key: "" }), "minLength");
  });

  it("rejects unknown top-level properties", () => {
    expectIllegal(
      "collaboration-request",
      { ...collaborationRequest(), priority: "high" },
      "additionalProperties",
    );
  });
});
