import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { PROTOCOL_VERSION, RoleDockError, validateRolePack } from "@roledock/protocol";
import type { RolePack } from "@roledock/protocol";

export interface PackFile {
  /** Path relative to the pack root, POSIX separators, as recorded in the hash. */
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface LoadedRolePack {
  readonly manifest: RolePack;
  readonly packRoot: string;
  /** SHA-256 over all pack files: sorted relative paths + NUL + file bytes. */
  readonly contentHash: string;
  readonly files: readonly PackFile[];
}

function validationError(message: string, details: Record<string, unknown>): RoleDockError {
  return new RoleDockError("VALIDATION_FAILED", message, { details });
}

function collectFiles(root: string, dir: string, out: PackFile[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw validationError(`Role packs must not contain symbolic links: ${relative(root, full)}`, {
        file: relative(root, full),
        issue: "symlink in pack",
      });
    }
    if (entry.isDirectory()) {
      collectFiles(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({ relativePath: relative(root, full).split(sep).join("/"), absolutePath: full });
  }
}

/**
 * Resolve a manifest-referenced path inside the pack and prove it stays
 * inside the pack root even across symlinked directories (realpath check).
 */
function resolveWithinPack(packRoot: string, referencedPath: string): string {
  const absolute = resolve(packRoot, referencedPath);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    throw validationError(`Role pack references a missing file: ${referencedPath}`, {
      file: referencedPath,
      issue: "missing file",
    });
  }
  const realRoot = realpathSync(packRoot);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw validationError(
      `Role pack reference escapes the pack root: ${referencedPath}`,
      { file: referencedPath, resolved: real, issue: "path escape" },
    );
  }
  return absolute;
}

/** Remote references in output schemas are data-loading hazards; only local (#, relative) refs are allowed. */
function findRemoteRefs(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) findRemoteRefs(item, found);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && /^https?:\/\//i.test(value)) {
        found.push(value);
      } else {
        findRemoteRefs(value, found);
      }
    }
  }
}

function hashFiles(files: readonly PackFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))) {
    hash.update(file.relativePath).update("\0").update(readFileSync(file.absolutePath));
  }
  return hash.digest("hex");
}

/**
 * Load and fully validate a local role pack directory (manifest must be
 * `rolepack.json` inside it). Performs every check the installer relies on:
 * schema validation, protocol version, referenced files exist, references
 * stay inside the pack root (symlink-safe), no remote $ref in output
 * schemas, and the pack content hash.
 */
export function loadRolePack(sourceDir: string): LoadedRolePack {
  const packRoot = resolve(sourceDir);
  let rootIsDirectory = false;
  try {
    rootIsDirectory = statSync(packRoot).isDirectory();
  } catch {
    rootIsDirectory = false;
  }
  if (!rootIsDirectory) {
    throw validationError(`Role pack source is not a directory: ${sourceDir}`, {
      source: sourceDir,
      issue: "missing pack directory",
    });
  }

  const manifestPath = join(packRoot, "rolepack.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw validationError(`Role pack manifest not found: ${manifestPath}`, {
      source: sourceDir,
      issue: "missing rolepack.json",
    });
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw validationError(`Role pack manifest is not valid JSON: ${(error as Error).message}`, {
      source: sourceDir,
      issue: "invalid JSON",
    });
  }

  const validated = validateRolePack(manifest);
  if (!validated.ok) {
    throw validationError("Role pack manifest failed validation.", {
      source: sourceDir,
      errors: validated.errors,
    });
  }
  const pack = validated.value;

  if (pack.requires_protocol !== PROTOCOL_VERSION) {
    throw validationError(
      `Role pack requires protocol ${pack.requires_protocol}, this build provides ${PROTOCOL_VERSION}.`,
      { requires_protocol: pack.requires_protocol, issue: "protocol version mismatch" },
    );
  }

  // Referenced files: instructions, document templates, output schemas.
  for (const role of pack.roles) {
    resolveWithinPack(packRoot, role.instructions);
    for (const document of role.documents ?? []) {
      resolveWithinPack(packRoot, document.template);
    }
    for (const outputSchema of role.output_schemas ?? []) {
      const schemaPath = resolveWithinPack(packRoot, outputSchema.schema);
      let schemaDoc: unknown;
      try {
        schemaDoc = JSON.parse(readFileSync(schemaPath, "utf8"));
      } catch (error) {
        throw validationError(
          `Output schema ${outputSchema.schema} is not valid JSON: ${(error as Error).message}`,
          { file: outputSchema.schema, issue: "invalid JSON" },
        );
      }
      const remoteRefs: string[] = [];
      findRemoteRefs(schemaDoc, remoteRefs);
      if (remoteRefs.length > 0) {
        throw validationError(
          `Output schema ${outputSchema.schema} references remote locations, which are not allowed at runtime.`,
          { file: outputSchema.schema, remote_refs: remoteRefs, issue: "remote schema reference" },
        );
      }
    }
  }

  const files: PackFile[] = [];
  collectFiles(packRoot, packRoot, files);
  if (!files.some((file) => file.relativePath === "rolepack.json")) {
    // Unreachable: the manifest was read above; guards hash coverage.
    throw validationError("Manifest missing from collected files", { issue: "internal" });
  }

  return { manifest: pack, packRoot, contentHash: hashFiles(files), files };
}
