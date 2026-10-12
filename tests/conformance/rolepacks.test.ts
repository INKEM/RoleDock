import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateRolePack } from "@roledock/protocol";
import type { RolePack } from "@roledock/protocol";

const fixturesDir = fileURLToPath(new URL("../fixtures/rolepacks/", import.meta.url));

describe("four distinct roles acceptance", () => {
  const pack = JSON.parse(
    readFileSync(`${fixturesDir}valid-four-roles.json`, "utf8"),
  ) as RolePack;

  it("validates as a legal role pack", () => {
    const result = validateRolePack(pack);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("carries exactly four mutually distinct role identities", () => {
    expect(pack.roles).toHaveLength(4);
    const ids = new Set(pack.roles.map((role) => role.id));
    expect(ids.size).toBe(4);
  });

  it("covers every visibility level across the pack", () => {
    const visibilities = new Set(
      pack.roles.flatMap((role) => (role.documents ?? []).map((d) => d.visibility)),
    );
    expect([...visibilities].sort()).toEqual(["private", "project", "role"]);
  });

  it("keeps capability requests as declarations without any grant semantics", () => {
    // The schema accepts arbitrary namespaced capability names; nothing in
    // the contract turns them into permissions.
    for (const role of pack.roles) {
      for (const capability of role.requested_capabilities ?? []) {
        expect(capability).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
      }
    }
  });
});

describe("illegal role pack fixtures are all rejected", () => {
  const invalidDir = `${fixturesDir}invalid/`;
  const files = readdirSync(invalidDir).filter((f) => f.endsWith(".json"));

  it("has a non-empty invalid fixture set", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(`rejects ${file}`, () => {
      const pack = JSON.parse(readFileSync(invalidDir + file, "utf8"));
      const result = validateRolePack(pack);
      expect(result.ok, `${file} unexpectedly validated`).toBe(false);
    });
  }
});
