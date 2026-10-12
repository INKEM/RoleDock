import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PackRoleSpec {
  id: string;
  title?: string;
  documents?: boolean;
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
 * file per role and, optionally, document templates.
 */
export function writePack(options: WritePackOptions): string {
  const roles: PackRoleSpec[] = options.roles ?? [{ id: "solo", title: "Solo" }];
  mkdirSync(join(options.dir, "roles"), { recursive: true });

  const manifestRoles = roles.map((role) => ({
    id: role.id,
    title: role.title ?? role.id.toUpperCase(),
    instructions: `roles/${role.id}.md`,
    ...(role.documents === false
      ? {}
      : {
          documents: [
            {
              key: "notes",
              title: "Notes",
              template: `templates/${role.id}-notes.md`,
              visibility: "project",
            },
          ],
        }),
    requested_capabilities: ["documents.read"],
  }));

  writeFileSync(join(options.dir, "rolepack.json"), JSON.stringify({
    schema_version: "0.1",
    name: options.name ?? "tiny-pack",
    version: options.version ?? "0.1.0",
    requires_protocol: "0.1",
    roles: manifestRoles,
  }, null, 2));

  for (const role of roles) {
    writeFileSync(join(options.dir, "roles", `${role.id}.md`), `# ${role.id}\n`);
    if (role.documents !== false) {
      mkdirSync(join(options.dir, "templates"), { recursive: true });
      writeFileSync(
        join(options.dir, "templates", `${role.id}-notes.md`),
        `# Notes\n\n${options.templateMarker ?? "marker"}\n`,
      );
    }
  }
  return options.dir;
}
