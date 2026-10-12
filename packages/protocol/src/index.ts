export {
  ERROR_CODES,
  type ErrorCode,
} from "./error-codes.js";
export {
  RoleDockError,
  isRoleDockError,
  toErrorEnvelope,
  type RoleDockErrorOptions,
} from "./errors.js";
export * from "./types.js";
export {
  validate,
  validateRolePack,
  SCHEMA_NAMES,
  type SchemaName,
  type SchemaValidationError,
  type ValidationResult,
} from "./validate.js";
