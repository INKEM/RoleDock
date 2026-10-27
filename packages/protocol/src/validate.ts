import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import ajvFormatsModule from "ajv-formats";
import type { RolePack } from "./types.js";

export type SchemaName =
  | "anchor-material"
  | "external-registration"
  | "service-control-operation"
  | "external-session"
  | "role-authorization"
  | "anchor-attempt"
  | "session-binding"
  | "session-operation"
  | "human-authorization-event"
  | "rolepack"
  | "role-head"
  | "document-revision"
  | "checkpoint"
  | "bootstrap-bundle"
  | "collaboration-request"
  | "candidate-update"
  | "knowledge-export"
  | "workspace-service-info"
  | "role-details"
  | "policy-list"
  | "workspace-runtime-status"
  | "authorization-confirmations"
  | "pending-human-events"
  | "host-session-discovery"
  | "session-bindings"
  | "anchor-attempts"
  | "anchor-loads"
  | "revoke-preview"
  | "output-envelope"
  | "error-envelope";

export const SCHEMA_NAMES: readonly SchemaName[] = [
  "external-registration",
  "service-control-operation",
  "external-session",
  "role-authorization",
  "anchor-attempt",
  "session-binding",
  "session-operation",
  "human-authorization-event",
  "rolepack",
  "role-head",
  "document-revision",
  "checkpoint",
  "bootstrap-bundle",
  "collaboration-request",
  "candidate-update",
  "knowledge-export",
  "workspace-service-info",
  "role-details",
  "policy-list",
  "workspace-runtime-status",
  "authorization-confirmations",
  "pending-human-events",
  "host-session-discovery",
  "session-bindings",
  "anchor-attempts",
  "anchor-loads",
  "revoke-preview",
  "output-envelope",
  "error-envelope",
  "anchor-material",
];

export interface SchemaValidationError {
  /** JSON path of the offending value, e.g. "/roles/0/instructions". */
  instancePath: string;
  keyword: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: SchemaValidationError[] };

const schemasDir = fileURLToPath(new URL("../schemas/", import.meta.url));

function loadSchema(name: SchemaName): object {
  const raw = readFileSync(`${schemasDir}${name}.schema.json`, "utf8");
  return JSON.parse(raw) as object;
}

// ajv-formats ships as CommonJS with `module.exports = formatsPlugin`; the
// runtime default import is the plugin function itself, so narrow explicitly.
type FormatsPlugin = (ajv: object, options?: unknown) => void;
const addFormats = ajvFormatsModule as unknown as FormatsPlugin;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const validators = new Map<SchemaName, ValidateFunction>(
  SCHEMA_NAMES.map((name) => [name, ajv.compile(loadSchema(name))]),
);

/** Validate a value against one of the protocol JSON Schemas. */
export function validate<T>(schemaName: SchemaName, value: unknown): ValidationResult<T> {
  const validateFn = validators.get(schemaName);
  if (validateFn === undefined) {
    throw new Error(`Unknown schema: ${schemaName}`);
  }
  const valid = validateFn(value) as boolean;
  if (valid) return { ok: true, value: value as T };
  const ajvErrors = validateFn.errors ?? [];
  return {
    ok: false,
    errors: ajvErrors.map((e: { instancePath: string; keyword: string; message?: string }) => ({
      instancePath: e.instancePath,
      keyword: e.keyword,
      message: e.message ?? "validation error",
    })),
  };
}

function duplicateEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry)) duplicates.push(entry);
    seen.add(entry);
  }
  return duplicates;
}

/**
 * Validate a role pack manifest: JSON Schema rules plus the semantic rules
 * JSON Schema cannot express — unique role ids, unique document and output
 * schema keys per role, unique capability requests per role. Role id
 * collisions across already-installed packs are a separate, installer-level
 * check (ROLE_ALREADY_EXISTS at P1).
 */
export function validateRolePack(value: unknown): ValidationResult<RolePack> {
  const result = validate<RolePack>("rolepack", value);
  if (!result.ok) return result;

  const pack = result.value;
  const semanticErrors: SchemaValidationError[] = [];

  const roleErrors = duplicateEntries(pack.roles.map((role) => role.id));
  for (const id of roleErrors) {
    semanticErrors.push({
      instancePath: "/roles",
      keyword: "uniqueness",
      message: `duplicate role id "${id}"`,
    });
  }

  for (const [index, role] of pack.roles.entries()) {
    const documentErrors = duplicateEntries((role.documents ?? []).map((d) => d.key));
    for (const key of documentErrors) {
      semanticErrors.push({
        instancePath: `/roles/${index}/documents`,
        keyword: "uniqueness",
        message: `duplicate document key "${key}" in role "${role.id}"`,
      });
    }
    const outputErrors = duplicateEntries((role.output_schemas ?? []).map((s) => s.key));
    for (const key of outputErrors) {
      semanticErrors.push({
        instancePath: `/roles/${index}/output_schemas`,
        keyword: "uniqueness",
        message: `duplicate output schema key "${key}" in role "${role.id}"`,
      });
    }
    const capabilityErrors = duplicateEntries(role.requested_capabilities ?? []);
    for (const capability of capabilityErrors) {
      semanticErrors.push({
        instancePath: `/roles/${index}/requested_capabilities`,
        keyword: "uniqueness",
        message: `duplicate capability request "${capability}" in role "${role.id}"`,
      });
    }
  }

  if (semanticErrors.length > 0) return { ok: false, errors: semanticErrors };
  return result;
}
