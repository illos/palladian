import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { ConvexCallError, type ConvexCaller } from "../src/convex.ts";
import { fns } from "../src/convex-api.ts";
import type { Env } from "../src/env.ts";
import { handleMcp, type McpContext } from "../src/mcp/handler.ts";
import { fakeEnv, fakeProvider, FakeKV, ORIGIN, type FakeProvider } from "./fakes.ts";

type Handler = (args: Record<string, unknown>) => unknown;

let provider: FakeProvider;
let env: Env;
let calls: { name: string; args: unknown }[];
let handlers: Map<unknown, Handler>;

const NOTEBOOK = {
  id: "nb1",
  name: "Notes",
  description: "Everything",
  role: "edit",
  ownerId: "p1",
  ownerName: "Ada",
  isDefault: false,
};

function fakeConvex(): ConvexCaller {
  const run = async (fn: unknown, args: unknown) => {
    calls.push({ name: String((fn as { _name?: string })._name ?? ""), args });
    const handler = handlers.get(fn);
    if (!handler) throw new Error("unexpected call");
    return handler(args as Record<string, unknown>);
  };
  return { query: run as never, mutation: run as never };
}

const ctx = (props: unknown = { agentId: "agent1", connectionId: "conn1" }): McpContext =>
  ({
    props,
    auth: { token: "agent1:grant9:secret", audience: `${ORIGIN}/mcp`, scope: ["notes"] },
    waitUntil: () => {},
    passThroughOnException: () => {},
  }) as unknown as McpContext;

function route(record: { status: number; wwwAuthenticate: string | null }[], context = ctx()) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const response = await handleMcp(new Request(input, init), env, context, { convex: async () => fakeConvex() });
    record.push({ status: response.status, wwwAuthenticate: response.headers.get("WWW-Authenticate") });
    return response;
  };
}

async function connect(mode: "modern" | "legacy", record: { status: number; wwwAuthenticate: string | null }[] = []) {
  const client = new Client(
    { name: "unit", version: "1.0.0" },
    mode === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), { fetch: route(record) }));
  return client;
}

beforeEach(() => {
  provider = fakeProvider();
  env = fakeEnv(new FakeKV(), provider);
  calls = [];
  handlers = new Map<unknown, Handler>([
    [fns.library.notebooks, () => [NOTEBOOK]],
    [fns.library.recent, () => ({ notes: [], nextBefore: null })],
  ]);
});

describe("/mcp", () => {
  it.each(["modern", "legacy"] as const)("lists annotated tools to %s clients", async (mode) => {
    const client = await connect(mode);
    expect(client.getProtocolEra()).toBe(mode);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_note",
      "create_notebook",
      "edit_note",
      "list_notebooks",
      "list_notes",
      "note_history",
      "read_note",
      "read_revision",
      "restore_note",
      "restore_revision",
      "search_notes",
      "trash_note",
    ]);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("read_note")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.get("trash_note")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(client.getInstructions()).toMatch(/untrusted data/);
    expect(calls).toEqual([]);
    await client.close();
  });

  it("returns text and structured content", async () => {
    const client = await connect("modern");
    const result = await client.callTool({ name: "list_notebooks", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      notebooks: [{ notebook_id: "nb1", name: "Notes", description: "Everything", role: "edit", owner: "Ada", is_default: false }],
    });
    expect((result.content as { text: string }[])[0]!.text).toContain("Filing guidance: Everything");
    await client.close();
  });

  it("maps backend errors to tool errors", async () => {
    handlers.set(fns.notes.readMarkdown, () => {
      throw new ConvexCallError({ kind: "backend", code: "not_found", message: "Note not found." });
    });
    const client = await connect("legacy");
    const result = await client.callTool({ name: "read_note", arguments: { note_id: "n1" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^Error \(not_found\): Note not found\./);
    await client.close();
  });

  it("requires expected_revision for replace_all before calling Convex", async () => {
    const client = await connect("modern");
    const result = await client.callTool({
      name: "edit_note",
      arguments: { note_id: "n1", edits: [{ type: "replace_all", markdown: "New" }] },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
    await client.close();
  });

  it.each(["modern", "legacy"] as const)(
    "answers a %s tool call on a revoked connection with 401 invalid_token and ends the grant",
    async (mode) => {
      const revoked = () => {
        throw new ConvexCallError({ kind: "backend", code: "unauthenticated", message: "Sign in to continue." });
      };
      handlers.set(fns.library.search, revoked);
      handlers.set(fns.library.notebooks, revoked);
      const record: { status: number; wwwAuthenticate: string | null }[] = [];
      const client = await connect(mode, record);
      await expect(client.callTool({ name: "search_notes", arguments: { query: "x" } })).rejects.toThrow();
      const last = record.at(-1)!;
      expect(last.status).toBe(401);
      expect(last.wwwAuthenticate).toContain('error="invalid_token"');
      expect(last.wwwAuthenticate).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
      expect(provider.revoked).toEqual([{ grantId: "grant9", userId: "agent1" }]);
      await client.close().catch(() => {});
    },
  );

  it("detects revocation behind list_notebooks' empty answer", async () => {
    handlers.set(fns.library.notebooks, () => []);
    handlers.set(fns.library.recent, () => {
      throw new ConvexCallError({ kind: "backend", code: "unauthenticated", message: "Sign in to continue." });
    });
    const record: { status: number; wwwAuthenticate: string | null }[] = [];
    const client = await connect("modern", record);
    await expect(client.callTool({ name: "list_notebooks", arguments: {} })).rejects.toThrow();
    expect(record.at(-1)!.status).toBe(401);
    await client.close().catch(() => {});
  });

  it("rejects a token without agent props", async () => {
    const response = await handleMcp(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
      env,
      ctx({}),
    );
    expect(response.status).toBe(401);
  });
});
