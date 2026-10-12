import { RoleDockError } from "@roledock/protocol";

export function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RoleDockError("VALIDATION_FAILED", "Operation input must be a JSON object.");
  }
  return input as Record<string, unknown>;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RoleDockError("VALIDATION_FAILED", `Input field "${key}" must be a non-empty string.`, {
      details: { field: key },
    });
  }
  return value;
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = optionalString(record, key);
  if (value === undefined) {
    throw new RoleDockError("VALIDATION_FAILED", `Input field "${key}" is required.`, {
      details: { field: key },
    });
  }
  return value;
}
