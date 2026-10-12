import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PackDocumentSpec {
  key: string;
  visibility: "private" | "role" | "project" | "public";
  title?: string;
  body?: string;
}

export interface PackRoleSpec {
  id: string;
  title?: string;
  documents?: boolean;
  /** Explicit document declarations (overrides the default notes document). */
  docs?: PackDocumentSpec[];
}

export interface WritePackOptions {
  /** Target directory for the pack (rolepack.json is written here). */
  dir: string;
  name?: string;
  version?: string;
  roles?: PackRoleSpec[];
  /** Written into every document template reference. */
  templateMarker?: string;
}

/**
 * Write a minimal valid role pack for tests: a manifest plus one instruction
 * file per role and document templates for every declared document.
 */
export function writePack(options: WritePackOptions): string {
  const roles: PackRoleSpec[] = options.roles ?? [{ id: "solo", title: "Solo" }];
  mkdirSync(join(options.dir, "roles"), { recursive: true });
  const marker = options.templateMarker ?? "marker";

  const manifestRoles = roles.map((role) => {
    const docs: PackDocumentSpec[] =
      role.docs ?? (role.documents === false ? [] : [{ key: "notes", visibility: "project" as const }]);
    return {
      id: role.id,
      title: role.title ?? role.id.toUpperCase(),
      instructions: `roles/${role.id}.md`,
      ...(docs.length > 0
        ? {
            documents: docs.map((document) => ({
              key: document.key,
              title: document.title ?? document.key,
              template: `templates/${role.id}-${document.key}.md`,
              visibility: document.visibility,
            })),
          }
        : {}),
      requested_capabilities: ["documents.read"],
    };
  });

  writeFileSync(
    join(options.dir, "rolepack.json"),
    JSON.stringify(
      {
        schema_version: "0.1",
        name: options.name ?? "tiny-pack",
        version: options.version ?? "0.1.0",
        requires_protocol: "0.1",
        roles: manifestRoles,
      },
      null,
      2,
    ),
  );

  for (const role of roles) {
    writeFileSync(join(options.dir, "roles", `${role.id}.md`), `# ${role.id}\n`);
    const docs: PackDocumentSpec[] =
      role.docs ?? (role.documents === false ? [] : [{ key: "notes", visibility: "project" as const }]);
    if (docs.length > 0) {
      mkdirSync(join(options.dir, "templates"), { recursive: true });
      for (const document of docs) {
        writeFileSync(
          join(options.dir, "templates", `${role.id}-${document.key}.md`),
          `# ${document.key}\n\n${document.body ?? marker}\n`,
        );
      }
    }
  }
  return options.dir;
}
