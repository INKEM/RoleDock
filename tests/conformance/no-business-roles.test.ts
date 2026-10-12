import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Acceptance: the core contains no business role enumeration. Demo role
 * names from the blueprint's example pack must never appear in any package
 * source; roles are pack data only (docs/spec/identity-and-permissions.md).
 */
const FORBIDDEN_ROLE_NAMES = /\b(builder|reviewer|explainer)\b/i;

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = `${dir}${entry.name}${entry.isDirectory() ? "/" : ""}`;
    if (entry.isDirectory()) return listSourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceFiles = ["protocol", "core", "cli"].flatMap((pkg) =>
  listSourceFiles(`${repoRoot}packages/${pkg}/src/`),
);

describe("no business roles in core source", () => {
  it("scans all package source files", () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of sourceFiles) {
    it(`contains no business role names: ${file.replace(repoRoot, "")}`, () => {
      const content = readFileSync(file, "utf8");
      expect(content.match(FORBIDDEN_ROLE_NAMES)).toBeNull();
    });
  }
});
