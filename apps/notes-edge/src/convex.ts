import { ConvexHttpClient } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

/** Error codes the backend raises as `ConvexError({ code, message })`. */
export type BackendErrorCode =
  | "unauthenticated"
  | "denied"
  | "not_found"
  | "invalid"
  | "conflict"
  | "trashed"
  | "too_large";

const BACKEND_CODES = new Set<string>([
  "unauthenticated",
  "denied",
  "not_found",
  "invalid",
  "conflict",
  "trashed",
  "too_large",
]);

/**
 * Why a Convex call failed, in the terms callers act on:
 * - `backend`: the function refused with a domain error; nothing was applied.
 * - `rejected`: the function ran and threw something else (argument validation,
 *   a bug); Convex mutations are transactional, so nothing was applied.
 * - `uncertain`: the request or its response was lost (network, timeout, 5xx);
 *   a write may or may not have been applied.
 */
export type CallFailure =
  | { kind: "backend"; code: BackendErrorCode; message: string }
  | {
      kind: "rejected";
      message: string;
      /** Convex refused the credentials (HTTP 401/403) before running anything. */
      credentials?: true;
    }
  | { kind: "uncertain"; message: string };

export class ConvexCallError extends Error {
  readonly failure: CallFailure;
  constructor(failure: CallFailure) {
    super(failure.message);
    this.name = "ConvexCallError";
    this.failure = failure;
  }
}

const CALL_TIMEOUT_MS = 25_000;

/** Convex's status for "the function ran and failed" responses. */
const UDF_FAILED = 560;

function backendError(error: unknown): CallFailure | null {
  if (!(error instanceof Error)) return null;
  const data = (error as Error & { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const { code, message } = data as Record<string, unknown>;
  if (typeof code !== "string" || !BACKEND_CODES.has(code)) return null;
  return {
    kind: "backend",
    code: code as BackendErrorCode,
    message: typeof message === "string" ? message : code,
  };
}

/** Turn Convex's argument-validation text into something an agent can act on. */
function rejectedMessage(raw: string): string {
  const path = /Path: \.(\w+)/.exec(raw)?.[1];
  if (/ArgumentValidationError|does not match validator/i.test(raw)) {
    const field = path ? fieldName(path) : null;
    return field
      ? `Invalid value for ${field}.`
      : "The request had an invalid argument.";
  }
  return "The server rejected the request. Nothing was changed.";
}

const FIELD_NAMES: Record<string, string> = {
  noteId: "note_id",
  notebookId: "notebook_id",
  requestId: "request_id",
  expectedRevision: "expected_revision",
  maxChars: "max_chars",
  includeTrashed: "include_trashed",
};
function fieldName(path: string): string {
  return FIELD_NAMES[path] ?? path;
}

export interface ConvexCaller {
  query<F extends FunctionReference<"query">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
  mutation<F extends FunctionReference<"mutation">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
}

/**
 * A Convex HTTP client that classifies every failure. `auth` is the agent JWT;
 * omit it for the unauthenticated calls the consent flow makes.
 */
export function convexCaller(
  url: string,
  options: { auth?: string; fetch?: typeof fetch } = {},
): ConvexCaller {
  const baseFetch = options.fetch ?? fetch;
  // Whether the deployment answered "the function ran and failed".
  let lastStatus: number | null = null;
  const trackingFetch: typeof fetch = async (input, init) => {
    lastStatus = null;
    // A stalled call becomes an "uncertain" failure the agent can retry.
    const response = await baseFetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    lastStatus = response.status;
    return response;
  };
  const client = new ConvexHttpClient(url, {
    logger: false,
    fetch: trackingFetch,
  });
  if (options.auth) client.setAuth(options.auth);

  async function run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const backend = backendError(error);
      if (backend) throw new ConvexCallError(backend);
      const raw = error instanceof Error ? error.message : String(error);
      if (lastStatus === UDF_FAILED)
        throw new ConvexCallError({
          kind: "rejected",
          message: rejectedMessage(raw),
        });
      // Convex refused the credentials before running anything.
      if (lastStatus === 401 || lastStatus === 403)
        throw new ConvexCallError({
          kind: "rejected",
          credentials: true,
          message:
            "The notes service did not accept this server's agent credentials (a server configuration problem). Nothing was changed.",
        });
      throw new ConvexCallError({
        kind: "uncertain",
        message:
          lastStatus === null
            ? "Could not reach the notes service."
            : `The notes service answered HTTP ${lastStatus}.`,
      });
    }
  }

  return {
    query: (fn, args) => run(() => client.query(fn, args)),
    // Each request uses its own client, so the mutation queue adds nothing.
    mutation: (fn, args) =>
      run(() => client.mutation(fn, args, { skipQueue: true })),
  };
}
