import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { RoleDockError } from "@roledock/protocol";

/** Declarative material can only reference regular files within its root. */
export function confinedFile(root: string, path: string): string {
  let issue = "missing file";
  try {
    if (!path || isAbsolute(path) || path.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
      issue = "path escape"; throw new Error("invalid relative path");
    }
    const realRoot = realpathSync(root);
    const lexical = resolve(root, path);
    if (!lexical.startsWith(resolve(root) + sep)) { issue = "path escape"; throw new Error(issue); }
    const real = realpathSync(lexical);
    if (!real.startsWith(realRoot + sep)) { issue = "path escape"; throw new Error(issue); }
    if (!statSync(real).isFile()) { issue = "not a regular file"; throw new Error(issue); }
    return real;
  } catch {
    throw new RoleDockError("VALIDATION_FAILED", `Material reference is missing, invalid or outside its root: ${path}`, {
      details: { file: path, issue },
    });
  }
}

export function readConfined(root: string, path: string): Buffer {
  return readFileSync(confinedFile(root, path));
}
