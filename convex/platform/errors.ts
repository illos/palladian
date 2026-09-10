import { ConvexError } from "convex/values";
import { LIMITS, type ErrorCode } from "../../packages/contracts/src/index";
const messages: Record<ErrorCode, string> = {
  UNAUTHENTICATED: "Sign in to continue.",
  FORBIDDEN: "This operation is not permitted.",
  NOT_FOUND: "This item is unavailable.",
  CONFLICT: "This item changed. Review the latest version and retry.",
  VALIDATION: "Check the supplied values.",
  RATE_LIMITED: "Too many requests. Try again shortly.",
  TEMPORARY: "The operation could not be completed. Try again.",
};
export function fail(code: ErrorCode): never {
  throw new ConvexError({ code, message: messages[code] });
}
export function revision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) fail("VALIDATION");
}
export function title(value: string) {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > LIMITS.titleCharacters)
    fail("VALIDATION");
  return normalized;
}
export function idempotencyKey(value: string) {
  if (
    value.length < LIMITS.minIdempotencyKeyCharacters ||
    value.length > LIMITS.idempotencyKeyCharacters ||
    !/^[A-Za-z0-9:_-]+$/.test(value)
  )
    fail("VALIDATION");
}
export function pagination(cursor: string | null, limit: number) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > LIMITS.maxListPage ||
    (cursor !== null &&
      (cursor.length < 1 || cursor.length > LIMITS.cursorCharacters))
  )
    fail("VALIDATION");
}

export function nextRevision(value: number) {
  revision(value);
  if (value === Number.MAX_SAFE_INTEGER) fail("CONFLICT");
  return value + 1;
}
