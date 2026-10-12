import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, RoleDockError, toErrorEnvelope, validate } from "../src/index.js";
import type { ErrorEnvelope, OutputEnvelope } from "../src/index.js";

const errorSchema = JSON.parse(
  readFileSync(new URL("../schemas/error-envelope.schema.json", import.meta.url), "utf8"),
) as { $defs: { errorCode: { enum: readonly string[] } } };

const requestSchema = JSON.parse(
  readFileSync(new URL("../schemas/collaboration-request.schema.json", import.meta.url), "utf8"),
) as { $defs: { errorCode: { enum: readonly string[] } } };

const schemaEnumCodes = errorSchema.$defs.errorCode.enum;
const requestEnumCodes = requestSchema.$defs.errorCode.enum;

describe("output envelope schema", () => {
  it("accepts a minimal success envelope", () => {
    const result = validate<OutputEnvelope>("output-envelope", { ok: true });
    expect(result.ok).toBe(true);
  });

  it("accepts a success envelope with data and correlation id", () => {
    const result = validate<OutputEnvelope>("output-envelope", {
      ok: true,
      data: { roles: ["alpha"] },
      request_id: "cli-001",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects ok: false in the success envelope", () => {
    expect(validate("output-envelope", { ok: false }).ok).toBe(false);
  });

  it("rejects unknown properties", () => {
    expect(
      validate("output-envelope", { ok: true, error: { code: "INTERNAL", message: "x" } }).ok,
    ).toBe(false);
  });
});

describe("error envelope schema", () => {
  it("accepts a legal error envelope", () => {
    const result = validate<ErrorEnvelope>("error-envelope", {
      ok: false,
      error: { code: "NOT_IMPLEMENTED", message: "not built yet", retryable: false },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an envelope with details and request id", () => {
    const result = validate<ErrorEnvelope>("error-envelope", {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "bad input",
        details: { instancePath: "/roles/0" },
      },
      request_id: "cli-002",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an error code outside the registry", () => {
    expect(
      validate("error-envelope", {
        ok: false,
        error: { code: "TOTALLY_MADE_UP", message: "x" },
      }).ok,
    ).toBe(false);
  });

  it("rejects an empty message", () => {
    expect(
      validate("error-envelope", { ok: false, error: { code: "INTERNAL", message: "" } }).ok,
    ).toBe(false);
  });
});

describe("error code registry sync", () => {
  it("ERROR_CODES matches the error-envelope enum exactly", () => {
    expect([...Object.keys(ERROR_CODES)].sort()).toEqual([...schemaEnumCodes].sort());
  });

  it("ERROR_CODES matches the collaboration-request error enum exactly", () => {
    expect([...Object.keys(ERROR_CODES)].sort()).toEqual([...requestEnumCodes].sort());
  });
});

describe("RoleDockError envelope conversion", () => {
  it("converts a RoleDockError losslessly", () => {
    const error = new RoleDockError("ROLE_UNINITIALIZED", "role not opened", {
      details: { role_id: "alpha" },
      retryable: true,
      requestId: "req-1",
    });
    const envelope = error.toEnvelope();
    expect(envelope).toEqual({
      ok: false,
      error: {
        code: "ROLE_UNINITIALIZED",
        message: "role not opened",
        details: { role_id: "alpha" },
        retryable: true,
      },
      request_id: "req-1",
    });
    expect(validate("error-envelope", envelope).ok).toBe(true);
  });

  it("wraps an unknown thrown value as INTERNAL", () => {
    const envelope = toErrorEnvelope(new Error("surprise"));
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("INTERNAL");
      expect(envelope.error.message).toBe("surprise");
    }
    expect(validate("error-envelope", envelope).ok).toBe(true);
  });

  it("wraps non-Error thrown values as INTERNAL", () => {
    const envelope = toErrorEnvelope("just a string");
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("INTERNAL");
  });
});
