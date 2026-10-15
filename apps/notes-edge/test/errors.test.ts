import { describe, expect, it } from "vitest";
import { ConvexCallError, convexCaller } from "../src/convex.ts";
import { asId, fns } from "../src/convex-api.ts";
import { failure, isRevoked } from "../src/mcp/results.ts";

function textOf(result: { content: unknown[] }): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

/** A fake Convex deployment answering every call with `respond`. */
function convexWith(respond: () => Response | Promise<Response>) {
  return convexCaller("https://example-123.convex.cloud", { fetch: async () => respond() });
}

const UDF_FAILED = 560;
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function failureOf(call: Promise<unknown>): Promise<ConvexCallError> {
  const error = await call.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexCallError);
  return error as ConvexCallError;
}

const noteArgs = { noteId: asId<"notes">("n1"), format: "markdown" as const };

describe("convexCaller failure classification", () => {
  it("returns values on success", async () => {
    const convex = convexWith(() => json({ status: "success", value: [], logLines: [] }, 200));
    expect(await convex.query(fns.library.notebooks, {})).toEqual([]);
  });

  it("surfaces ConvexError codes as backend failures", async () => {
    const convex = convexWith(() =>
      json({ status: "error", errorMessage: "Note not found.", errorData: { code: "not_found", message: "Note not found." }, logLines: [] }, UDF_FAILED),
    );
    const error = await failureOf(convex.query(fns.notes.readMarkdown, noteArgs));
    expect(error.failure).toEqual({ kind: "backend", code: "not_found", message: "Note not found." });
  });

  it("treats argument validation as a definite rejection naming the agent's field", async () => {
    const convex = convexWith(() =>
      json(
        {
          status: "error",
          errorMessage: 'ArgumentValidationError: Value does not match validator.\nPath: .noteId\nValue: "x"\nValidator: v.id("notes")',
          logLines: [],
        },
        UDF_FAILED,
      ),
    );
    const error = await failureOf(convex.query(fns.notes.readMarkdown, noteArgs));
    expect(error.failure).toEqual({ kind: "rejected", message: "Invalid value for note_id." });
  });

  it("treats refused credentials as a rejection, not an uncertain write", async () => {
    const convex = convexWith(() => new Response("Unauthenticated", { status: 401 }));
    const error = await failureOf(convex.mutation(fns.notes.trash, { noteId: asId<"notes">("n1") }));
    expect(error.failure.kind).toBe("rejected");
  });

  it("treats network failures and server errors as uncertain", async () => {
    const unreachable = convexCaller("https://example-123.convex.cloud", {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect((await failureOf(unreachable.query(fns.library.notebooks, {}))).failure.kind).toBe("uncertain");
    const broken = convexWith(() => new Response("oops", { status: 502 }));
    const error = await failureOf(broken.mutation(fns.notes.trash, { noteId: asId<"notes">("n1") }));
    expect(error.failure).toEqual({ kind: "uncertain", message: "The notes service answered HTTP 502." });
  });
});

describe("Convex failures as MCP tool results", () => {
  const backend = (code: "not_found" | "denied" | "conflict" | "invalid" | "trashed" | "too_large" | "unauthenticated", message: string) =>
    new ConvexCallError({ kind: "backend", code, message });

  it.each([
    ["not_found", "Note not found."],
    ["denied", "This action needs edit access to the note."],
    ["conflict", "The note changed (revision 4, expected 3). Read it again."],
    ["invalid", "Edit 1: old_text appears more than once."],
    ["trashed", "The note is in Trash."],
    ["too_large", "Markdown exceeds the supported size."],
  ] as const)("maps %s to an isError result carrying the backend's message", (code, message) => {
    const result = failure(backend(code, message), "read");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`Error (${code}): ${message}`);
    expect(result.structuredContent).toMatchObject({ error: { code, retryable: false } });
  });

  it("adds guidance to not_found and denied", () => {
    expect(textOf(failure(backend("not_found", "Note not found."), "read"))).toMatch(/not shared with this agent/);
    expect(textOf(failure(backend("denied", "Needs edit."), "read"))).toMatch(/Ask the person to share/);
  });

  it("recognises a revoked connection", () => {
    const error = backend("unauthenticated", "Sign in to continue.");
    expect(isRevoked(error)).toBe(true);
    expect(isRevoked(backend("denied", "x"))).toBe(false);
    const result = failure(error, "read");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("maps rejected calls to invalid", () => {
    const result = failure(new ConvexCallError({ kind: "rejected", message: "Invalid value for note_id." }), "idempotent");
    expect(textOf(result)).toBe("Error (invalid): Invalid value for note_id.");
  });

  it("says when a write's outcome is uncertain and how to retry safely", () => {
    const lost = new ConvexCallError({ kind: "uncertain", message: "Could not reach the notes service." });
    expect(textOf(failure(lost, "read"))).toMatch(/Try again\.$/);
    const idempotent = textOf(failure(lost, "idempotent"));
    expect(idempotent).toMatch(/may or may not have been saved/);
    expect(idempotent).toMatch(/same request_id/);
    expect(textOf(failure(lost, "unsafe"))).toMatch(/Check before retrying/);
    expect(failure(lost, "idempotent").structuredContent).toMatchObject({ error: { code: "unavailable", retryable: true } });
  });

  it("treats unknown errors as uncertain", () => {
    expect(failure(new Error("boom"), "unsafe").structuredContent).toMatchObject({ error: { code: "unavailable" } });
  });
});
