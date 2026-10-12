import { describe, expect, it } from "vitest";
import { validate } from "../src/index.js";
import type { CandidateUpdate, KnowledgeExportManifest } from "../src/index.js";
import { TS, HASH } from "./helpers.js";

function candidate(overrides: Partial<CandidateUpdate> = {}): CandidateUpdate {
  return {
    candidate_id: "cand-abc",
    workspace_id: "ws-main",
    target_role_id: "alpha",
    document_key: "state",
    baseline_revision: 1,
    proposed_body_hash: HASH,
    proposed_by_session_id: "sess-beta-1",
    proposed_by_role_id: "beta",
    source: "documents.propose",
    state: "open",
    created_at: TS,
    ...overrides,
  };
}

function manifest(overrides: Partial<KnowledgeExportManifest> = {}): KnowledgeExportManifest {
  return {
    manifest_version: "0.1",
    source_workspace_id: "ws-main",
    scope: "share",
    exported_at: TS,
    content_hash_algorithm: "sha256",
    entries: [
      {
        owner_role_id: "alpha",
        document_key: "state",
        revision: 2,
        content_hash: HASH,
        visibility: "project",
        created_by_instance_id: "inst-alpha-1",
        created_at: TS,
        file: "documents/alpha/state-r2.md",
      },
    ],
    ...overrides,
  };
}

describe("candidate-update schema", () => {
  it("accepts a legal candidate", () => {
    expect(validate<CandidateUpdate>("candidate-update", candidate()).ok).toBe(true);
  });

  it("accepts an adopted candidate with resolution fields", () => {
    expect(
      validate<CandidateUpdate>(
        "candidate-update",
        candidate({ state: "adopted", adopted_revision: 3, resolved_at: TS }),
      ).ok,
    ).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(
      validate("candidate-update", candidate({ source: "magic" as CandidateUpdate["source"] })).ok,
    ).toBe(false);
  });

  it("rejects an unknown state", () => {
    expect(
      validate("candidate-update", candidate({ state: "pending" as CandidateUpdate["state"] })).ok,
    ).toBe(false);
  });

  it("rejects a non-hash body hash", () => {
    expect(validate("candidate-update", candidate({ proposed_body_hash: "zz" })).ok).toBe(false);
  });

  it("rejects baseline_revision below zero", () => {
    expect(validate("candidate-update", candidate({ baseline_revision: -1 })).ok).toBe(false);
  });
});

describe("knowledge-export schema", () => {
  it("accepts a legal share manifest", () => {
    expect(validate<KnowledgeExportManifest>("knowledge-export", manifest()).ok).toBe(true);
  });

  it("accepts a workspace manifest with checkpoints", () => {
    expect(
      validate<KnowledgeExportManifest>(
        "knowledge-export",
        manifest({
          scope: "workspace",
          checkpoints: [
            {
              checkpoint_id: "ckpt-1",
              role_id: "alpha",
              generation: 1,
              knowledge_revision: 3,
              content_hash: HASH,
              file: "checkpoints/alpha-ckpt-1.json",
            },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it("rejects a wrong manifest version", () => {
    expect(
      validate("knowledge-export", manifest({ manifest_version: "1.0" as unknown as "0.1" })).ok,
    ).toBe(false);
  });

  it("rejects an unknown scope", () => {
    expect(
      validate("knowledge-export", manifest({ scope: "everything" as KnowledgeExportManifest["scope"] })).ok,
    ).toBe(false);
  });

  it("rejects a wrong hash algorithm", () => {
    expect(
      validate(
        "knowledge-export",
        manifest({ content_hash_algorithm: "md5" as unknown as "sha256" }),
      ).ok,
    ).toBe(false);
  });

  it("rejects entries with unknown properties", () => {
    const bad = manifest();
    (bad.entries[0] as unknown as Record<string, unknown>).extra = true;
    expect(validate("knowledge-export", bad).ok).toBe(false);
  });
});

describe("visibility ladder (P2)", () => {
  it("document-revision schema accepts all four levels", () => {
    for (const visibility of ["private", "role", "project", "public"] as const) {
      const result = validate("document-revision", {
        workspace_id: "ws-main",
        role_id: "alpha",
        document_key: "state",
        revision: 1,
        content_hash: HASH,
        visibility,
        created_by_instance_id: "inst-alpha-1",
        created_at: TS,
      });
      expect(result.ok, `visibility ${visibility} should be legal`).toBe(true);
    }
  });
});
