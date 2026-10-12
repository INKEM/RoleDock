import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceStore } from "./workspace.js";

/**
 * Content-addressed body storage: `<root>/.roledock/objects/<hash[:2]>/<hash>`.
 * Document revisions, candidate bodies and imported material all live here;
 * identical content is stored once and exports read straight from it.
 */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function putObject(store: WorkspaceStore, body: string): string {
  const hash = bodyHash(body);
  const objectDir = join(store.root, ".roledock", "objects", hash.slice(0, 2));
  mkdirSync(objectDir, { recursive: true });
  const objectPath = join(objectDir, hash);
  if (!existsSync(objectPath)) {
    writeFileSync(objectPath, body, "utf8");
  }
  return hash;
}

export function objectPath(store: WorkspaceStore, hash: string): string {
  return join(store.root, ".roledock", "objects", hash.slice(0, 2), hash);
}

export function readObject(store: WorkspaceStore, hash: string): string {
  return readFileSync(objectPath(store, hash), "utf8");
}
