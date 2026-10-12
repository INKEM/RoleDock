import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleDockError, isRoleDockError } from "@roledock/protocol";
import { loadRolePack } from "../src/index.js";
import { writePack } from "../../../tests/helpers/packs.js";

const TEMP_ROOTS: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "roledock-loader-"));
  TEMP_ROOTS.push(root);
  return root;
}

afterEach(() => {
  while (TEMP_ROOTS.length > 0) {
    const root = TEMP_ROOTS.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function expectValidationIssue(run: () => unknown, issue: string) {
  try {
    run();
    expect.unreachable(`expected VALIDATION_FAILED (${issue})`);
  } catch (error) {
    expect(isRoleDockError(error)).toBe(true);
    if (isRoleDockError(error)) {
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(error.details)).toContain(issue);
      return;
    }
    throw new Error("expected RoleDockError");
  }
}

describe("role pack loader", () => {
  it("loads a valid pack with a deterministic content hash", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir, name: "hash-pack" });

    const first = loadRolePack(packDir);
    const second = loadRolePack(packDir);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.manifest.name).toBe("hash-pack");
    expect(first.files.map((file) => file.relativePath)).toContain("rolepack.json");
  });

  it("rejects a pack whose referenced template file is missing", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir });
    rmSync(join(packDir, "templates", "solo-notes.md"));
    expectValidationIssue(() => loadRolePack(packDir), "missing file");
  });

  it("rejects a pack missing the manifest", () => {
    const root = makeRoot();
    expectValidationIssue(() => loadRolePack(join(root, "nowhere")), "missing pack directory");
  });

  it("rejects symlink escapes for referenced files", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir });
    const outside = join(root, "outside.md");
    writeFileSync(outside, "outside");
    rmSync(join(packDir, "templates", "solo-notes.md"));
    symlinkSync(outside, join(packDir, "templates", "solo-notes.md"));
    expectValidationIssue(() => loadRolePack(packDir), "path escape");
  });

  it("rejects stray symlinks anywhere in the pack, even unreferenced ones", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir });
    symlinkSync("/etc/hostname", join(packDir, "roles", "sneaky.md"));
    expectValidationIssue(() => loadRolePack(packDir), "symlink in pack");
  });

  it("rejects references that escape the pack root through a symlinked directory", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir });
    const outsideDir = join(root, "outside");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "solo-notes.md"), "outside");
    rmSync(join(packDir, "templates"), { recursive: true });
    symlinkSync(outsideDir, join(packDir, "templates"));
    expectValidationIssue(() => loadRolePack(packDir), "path escape");
  });

  it("rejects remote $ref in output schemas", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir, name: "remote-ref-pack" });
    mkdirSync(join(packDir, "schemas"));
    writeFileSync(
      join(packDir, "schemas", "report.json"),
      JSON.stringify({
        type: "object",
        properties: {
          answer: { $ref: "https://schemas.example.com/answer.json" },
        },
      }),
    );
    const manifestPath = join(packDir, "rolepack.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.roles[0].output_schemas = [{ key: "report", schema: "schemas/report.json" }];
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expectValidationIssue(() => loadRolePack(packDir), "remote schema reference");
  });

  it("rejects a manifest with path traversal before touching the filesystem", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir });
    const manifestPath = join(packDir, "rolepack.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.roles[0].instructions = "roles/../../etc/passwd";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expectValidationIssue(() => loadRolePack(packDir), "errors");
  });

  it("rejects a pack requiring a different protocol version", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir, name: "future-pack" });
    const manifestPath = join(packDir, "rolepack.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.requires_protocol = "9.9";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expectValidationIssue(() => loadRolePack(packDir), "requires_protocol");
  });

  it("reports loader failures as structured VALIDATION_FAILED errors", () => {
    const root = makeRoot();
    const packDir = join(root, "pack");
    writePack({ dir: packDir });
    rmSync(join(packDir, "templates", "solo-notes.md"));
    try {
      loadRolePack(packDir);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RoleDockError);
    }
  });
});
