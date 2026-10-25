import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { PROTOCOL_VERSION, RoleDockError, validateRolePack } from "@roledock/protocol";
import { confinedFile } from "../files.js";
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
  return confinedFile(packRoot, referencedPath);
}

/** Walk the complete reference graph, including recursive local schemas. */
function validateSchemaClosure(root: string, path: string, visited: Set<string>): void {
  const file = resolveWithinPack(root, path);
  if (visited.has(file)) return;
  visited.add(file);
  let doc: unknown;
  try { doc = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw validationError("Output schema is not valid JSON", { file: path }); }
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === "$ref" || key === "$dynamicRef" || key === "$id") && typeof value === "string") {
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//") || value.includes("?") || value.includes("\\")) {
          throw validationError("Only local schema references are allowed", { file: path, reference: value, issue: "remote schema reference" });
        }
        const [refPath, fragment] = value.split("#");
        if (fragment !== undefined && !/^(?:|\/[\s\S]*|[A-Za-z_][A-Za-z0-9_.:-]*)$/.test(fragment)) {
          throw validationError("Invalid schema fragment", { reference: value });
        }
        if (key === "$id" && refPath) {
          throw validationError("Schema ids must be local fragments; relative references use the containing file", { reference: value });
        }
        if (key !== "$id") {
          let decoded: string;
          let decodedFragment: string;
          try { decoded = decodeURIComponent(refPath ?? ""); decodedFragment = decodeURIComponent(fragment ?? ""); }
          catch { throw validationError("Invalid schema URI", { reference: value }); }
          if (decoded.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.includes("\\")) throw validationError("Invalid schema URI", { reference: value });
          const targetPath = decoded ? relative(root, resolve(dirname(file), decoded)) : path;
          const targetFile = resolveWithinPack(root, targetPath);
          let target: unknown;
          try { target = targetFile === file ? doc : JSON.parse(readFileSync(targetFile, "utf8")); }
          catch { throw validationError("Referenced schema is not valid JSON", { reference: value }); }
          if (decodedFragment.startsWith("/")) {
            let selected = target;
            for (const token of decodedFragment.slice(1).split("/")) {
              if (/~(?![01])/.test(token)) throw validationError("Invalid JSON pointer", { reference: value });
              const property = token.replace(/~1/g, "/").replace(/~0/g, "~");
              if (!selected || typeof selected !== "object" || !Object.hasOwn(selected, property)) throw validationError("Missing schema fragment", { reference: value });
              selected = (selected as Record<string, unknown>)[property];
            }
          } else if (decodedFragment) {
            const hasAnchor = (node: unknown): boolean => !!node && typeof node === "object" &&
              (Object.entries(node).some(([k, v]) => ((k === "$anchor" || k === "$dynamicAnchor") && v === decodedFragment) || (k === "$id" && v === `#${decodedFragment}`)) || Object.values(node).some(hasAnchor));
            if (!hasAnchor(target)) throw validationError("Missing schema anchor", { reference: value });
          }
          validateSchemaClosure(root, targetPath, visited);
        }
      } else walk(value);
    }
  };
  walk(doc);
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
      validateSchemaClosure(packRoot, outputSchema.schema, new Set());
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

/** Complete local file set for one role's output schema; used in host materials. */
export function schemaClosureFiles(root: string, path: string): string[] {
  const visited = new Set<string>();
  validateSchemaClosure(root, path, visited);
  return [...visited].map((file) => relative(root, file).split(sep).join("/"));
}
