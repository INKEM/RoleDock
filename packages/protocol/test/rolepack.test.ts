import { describe, expect, it } from "vitest";
import { validateRolePack } from "../src/index.js";
import type { RolePack } from "../src/index.js";
import { rolePack } from "./helpers.js";

function expectRejected(
  value: unknown,
  expected?: { keyword?: string; message?: string },
) {
  const result = validateRolePack(value);
  expect(result.ok).toBe(false);
  if (!result.ok && expected?.keyword !== undefined) {
    expect(result.errors.map((e) => e.keyword)).toContain(expected.keyword);
  }
  if (!result.ok && expected?.message !== undefined) {
    expect(
      result.errors.some((e) => e.message.includes(expected.message as string)),
      `expected an error containing "${expected.message}", got ${JSON.stringify(result.errors)}`,
    ).toBe(true);
  }
  return result;
}

describe("rolepack schema — legal inputs", () => {
  it("accepts a minimal single-role pack", () => {
    const result = validateRolePack(rolePack());
    expect(result.ok).toBe(true);
  });

  it("accepts a pack using documents, output schemas and capability requests", () => {
    const result = validateRolePack(
      rolePack({
        name: "full-pack",
        roles: [
          {
            id: "alpha",
            title: "Alpha",
            description: "Does alpha work.",
            instructions: "roles/alpha.md",
            documents: [
              { key: "state", template: "templates/state.md", visibility: "project" },
              { key: "journal", template: "templates/journal.md", visibility: "role" },
              { key: "scratch", template: "templates/scratch.md", visibility: "private" },
            ],
            output_schemas: [
              { key: "report", schema: "schemas/report.json" },
            ],
            requested_capabilities: ["documents.read", "documents.publish"],
          },
          {
            id: "beta",
            title: "Beta",
            instructions: "roles/beta.md",
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts four mutually distinct roles with arbitrary ids", () => {
    const result = validateRolePack(
      rolePack({
        name: "four-roles",
        roles: ["archivist", "cartographer", "gardener", "navigator"].map((id) => ({
          id,
          title: id.toUpperCase(),
          instructions: `roles/${id}.md`,
        })),
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("rolepack schema — illegal inputs", () => {
  it("rejects missing required top-level fields", () => {
    const pack = rolePack();
    delete (pack as Partial<RolePack>).roles;
    expectRejected(pack, { keyword: "required" });
  });

  it("rejects an unsupported schema_version", () => {
    expectRejected(rolePack({ schema_version: "0.2" as unknown as "0.1" }), { keyword: "const" });
  });

  it("rejects a mismatched requires_protocol", () => {
    expectRejected(rolePack({ requires_protocol: "1.0" as unknown as "0.1" }), { keyword: "const" });
  });

  it("rejects a non-semver version", () => {
    expectRejected(rolePack({ version: "1.0" }), { keyword: "pattern" });
  });

  it("rejects an empty roles array", () => {
    expectRejected(rolePack({ roles: [] }), { keyword: "minItems" });
  });

  it("rejects an uppercase role id", () => {
    expectRejected(
      rolePack({ roles: [{ id: "Alpha", title: "A", instructions: "roles/a.md" }] }),
      { keyword: "pattern" },
    );
  });

  it("rejects unknown top-level properties", () => {
    expectRejected({ ...rolePack(), extra: true }, { keyword: "additionalProperties" });
  });

  it("rejects document visibility outside the enum", () => {
    expectRejected(
      rolePack({
        roles: [
          {
            id: "alpha",
            title: "Alpha",
            instructions: "roles/alpha.md",
            documents: [
              {
                key: "state",
                template: "templates/state.md",
                visibility: "workspace" as unknown as "project",
              },
            ],
          },
        ],
      }),
      { keyword: "enum" },
    );
  });

  it("rejects path traversal in package paths", () => {
    expectRejected(
      rolePack({
        roles: [
          { id: "alpha", title: "Alpha", instructions: "roles/../../etc/passwd" },
        ],
      }),
      { keyword: "not" },
    );
  });

  it("rejects absolute package paths", () => {
    expectRejected(
      rolePack({
        roles: [{ id: "alpha", title: "Alpha", instructions: "/etc/passwd" }],
      }),
      { keyword: "pattern" },
    );
  });

  it("rejects a backslash path", () => {
    expectRejected(
      rolePack({
        roles: [{ id: "alpha", title: "Alpha", instructions: "roles\\alpha.md" }],
      }),
      { keyword: "pattern" },
    );
  });

  it("rejects a dot-leading relative path", () => {
    expectRejected(
      rolePack({
        roles: [{ id: "alpha", title: "Alpha", instructions: "./roles/alpha.md" }],
      }),
      { keyword: "pattern" },
    );
  });

  it("rejects a capability request without a namespace", () => {
    expectRejected(
      rolePack({
        roles: [
          {
            id: "alpha",
            title: "Alpha",
            instructions: "roles/alpha.md",
            requested_capabilities: ["read"],
          },
        ],
      }),
      { keyword: "pattern" },
    );
  });
});

describe("rolepack semantic rules beyond JSON Schema", () => {
  it("rejects duplicate role ids", () => {
    const shared = { title: "T", instructions: "roles/t.md" };
    const result = expectRejected(
      rolePack({ roles: [{ id: "twin", ...shared }, { id: "twin", ...shared }] }),
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [{ message: 'duplicate role id "twin"' }],
    });
  });

  it("rejects duplicate document keys within a role", () => {
    expectRejected(
      rolePack({
        roles: [
          {
            id: "alpha",
            title: "Alpha",
            instructions: "roles/alpha.md",
            documents: [
              { key: "state", template: "templates/a.md", visibility: "project" },
              { key: "state", template: "templates/b.md", visibility: "role" },
            ],
          },
        ],
      }),
      { message: 'duplicate document key "state"' },
    );
  });

  it("rejects duplicate output schema keys within a role", () => {
    expectRejected(
      rolePack({
        roles: [
          {
            id: "alpha",
            title: "Alpha",
            instructions: "roles/alpha.md",
            output_schemas: [
              { key: "report", schema: "schemas/a.json" },
              { key: "report", schema: "schemas/b.json" },
            ],
          },
        ],
      }),
      { message: 'duplicate output schema key "report"' },
    );
  });

  it("rejects duplicate capability requests within a role", () => {
    expectRejected(
      rolePack({
        roles: [
          {
            id: "alpha",
            title: "Alpha",
            instructions: "roles/alpha.md",
            requested_capabilities: ["documents.read", "documents.read"],
          },
        ],
      }),
      { message: 'duplicate capability request "documents.read"' },
    );
  });

  it("still accepts distinct document keys across different roles", () => {
    const result = validateRolePack(
      rolePack({
        roles: [
          {
            id: "alpha",
            title: "Alpha",
            instructions: "roles/alpha.md",
            documents: [{ key: "state", template: "templates/a.md", visibility: "project" }],
          },
          {
            id: "beta",
            title: "Beta",
            instructions: "roles/beta.md",
            documents: [{ key: "state", template: "templates/b.md", visibility: "role" }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("rolepack type mapping", () => {
  it("validates a value typed as RolePack without casts", () => {
    const pack: RolePack = rolePack({
      roles: [
        {
          id: "typed",
          title: "Typed",
          instructions: "roles/typed.md",
          documents: [{ key: "notes", template: "templates/notes.md", visibility: "role" }],
        },
      ],
    });
    expect(validateRolePack(pack).ok).toBe(true);
  });
});
