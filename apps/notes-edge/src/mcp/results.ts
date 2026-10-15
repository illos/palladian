import type { CallToolResult } from "@modelcontextprotocol/server";
import { ConvexCallError, type CallFailure } from "../convex.ts";

/** A successful tool result: readable text for the model plus structured data. */
export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

export type WriteSafety =
  /** Reads: retrying is always safe. */
  | "read"
  /** Writes carrying a request_id or otherwise idempotent: retry the same call. */
  | "idempotent"
  /** Writes that may duplicate on retry: check first. */
  | "unsafe";

/**
 * Convex no longer accepts this agent's connection (revoked, or the agent or
 * its person disabled). The HTTP layer answers such requests with a 401.
 */
export function isRevoked(error: unknown): boolean {
  return (
    error instanceof ConvexCallError &&
    error.failure.kind === "backend" &&
    error.failure.code === "unauthenticated"
  );
}

export function revokedResult(): CallToolResult {
  const message = "This connection was revoked or its agent was disabled. Sign in again.";
  return {
    content: [{ type: "text", text: `Error (unauthenticated): ${message}` }],
    structuredContent: { error: { code: "unauthenticated", message, retryable: false } },
    isError: true,
  };
}

export function invalidInput(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Error (invalid): ${message}` }],
    structuredContent: { error: { code: "invalid", message, retryable: false } },
    isError: true,
  };
}

const HINTS: Partial<Record<string, string>> = {
  not_found:
    "The ID may be wrong, or the item was deleted or is not shared with this agent.",
  denied: "Ask the person to share it with this agent with the access needed.",
};

/** Map a failed Convex call to a clear `isError` tool result. */
export function failure(error: unknown, safety: WriteSafety): CallToolResult {
  if (isRevoked(error)) return revokedResult();
  const detail: CallFailure =
    error instanceof ConvexCallError
      ? error.failure
      : { kind: "uncertain", message: "Unexpected server error." };
  let text: string;
  let code: string;
  let retryable = false;
  switch (detail.kind) {
    case "backend": {
      code = detail.code;
      const hint = HINTS[detail.code];
      text = hint ? `${detail.message} ${hint}` : detail.message;
      break;
    }
    case "rejected":
      code = "invalid";
      text = detail.message;
      break;
    case "uncertain":
      code = "unavailable";
      retryable = true;
      text =
        safety === "read"
          ? `${detail.message} Try again.`
          : safety === "idempotent"
            ? `${detail.message} The change may or may not have been saved. Retry the same call with the same request_id; it will not be applied twice.`
            : `${detail.message} The change may or may not have been saved. Check before retrying so it is not applied twice.`;
      break;
  }
  return {
    content: [{ type: "text", text: `Error (${code}): ${text}` }],
    structuredContent: { error: { code, message: text, retryable } },
    isError: true,
  };
}
