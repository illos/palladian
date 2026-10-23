import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConvexCallError, type ConvexCaller } from "../src/convex.ts";
import { fns } from "../src/convex-api.ts";
import type { Env } from "../src/env.ts";
import { sha256Hex } from "../src/files.ts";
import { handleMcp, type McpContext } from "../src/mcp/handler.ts";
import { ATTACH_MAX_BYTES } from "../src/mcp/tools.ts";
import { fakeEnv, fakeProvider, FakeKV, ORIGIN } from "./fakes.ts";
import { localR2 } from "./local-r2.mjs";

/** attach_file: the agent's Convex calls and the file service are fakes; R2 is local. */

type Handler = (args: Record<string, unknown>) => unknown;
let r2: Awaited<ReturnType<typeof localR2>>;
let env: Env;
let agentHandlers: Map<unknown, Handler>;
let serviceHandlers: Map<unknown, Handler>;
let calls: { as: string; name: string; args: Record<string, unknown> }[];
let withFiles: boolean;

const OBJECT = "obj0000000000000001abcdef";
const NOTE = "note000000000000001";

function fake(as: string, handlers: Map<unknown, Handler>): ConvexCaller {
  const run = async (fn: unknown, args: unknown) => {
    calls.push({
      as,
      name: getFunctionName(fn as FunctionReference<"query" | "mutation">),
      args: args as Record<string, unknown>,
    });
    const handler = handlers.get(fn);
    if (!handler) throw new Error("unexpected call");
    return handler(args as Record<string, unknown>);
  };
  return { query: run as never, mutation: run as never };
}

const context = {
  props: { agentId: "agent1", connectionId: "conn1" },
  auth: { token: "agent1:grant9:secret", audience: `${ORIGIN}/mcp`, scope: [] },
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as McpContext;

async function connect() {
  const client = new Client({ name: "unit", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: (input, init) =>
        handleMcp(
          new Request(input, init),
          withFiles ? { ...env, FILES: r2.bucket } : env,
          context,
          {
            convex: async () => fake("agent", agentHandlers),
            files: { service: async () => fake("service", serviceHandlers) },
          },
        ),
    }),
  );
  return client;
}

const base64 = (text: string) => btoa(text);

/** Convex grants a ticket for `content`, and accepts it once stored. */
async function granting(
  content: string,
  mimeType: string,
  state: "pending" | "ready" | "failed" = "pending",
) {
  const hash = await sha256Hex(new TextEncoder().encode(content));
  agentHandlers.set(fns.files.createUpload, (args) => ({
    objectId: OBJECT,
    state,
    ticket: state === "pending" ? "k".repeat(43) : null,
    expiresAt: null,
    name: String(args.name).trim(),
    mimeType,
    replayed: state !== "pending",
  }));
  serviceHandlers.set(fns.files.admitUpload, () => ({
    status: "pending",
    size: content.length,
    sha256: hash,
    mimeType,
    leaseUntil: Date.now() + 15 * 60_000,
  }));
  serviceHandlers.set(fns.files.finalize, () => ({ status: "ready" }));
  agentHandlers.set(fns.notes.edit, () => ({
    revision: 4,
    previousRevision: 3,
    title: "Trip",
    replayed: false,
  }));
  return hash;
}

async function attach(args: Record<string, unknown>) {
  const client = await connect();
  const result = await client.callTool({
    name: "attach_file",
    arguments: { note_id: NOTE, ...args },
  });
  await client.close();
  return result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: { text: string }[];
  };
}

beforeAll(async () => {
  r2 = await localR2();
});
afterAll(async () => {
  await r2.dispose();
});
beforeEach(async () => {
  env = fakeEnv(new FakeKV(), fakeProvider());
  agentHandlers = new Map();
  serviceHandlers = new Map();
  calls = [];
  withFiles = true;
  await r2.bucket.delete(`objects/${OBJECT}`);
});

describe("attach_file", () => {
  it("uploads an image and appends it to the note", async () => {
    const hash = await granting("GIF89a-bytes", "image/gif");
    const result = await attach({
      filename: "chart [v2].gif",
      mime_type: "image/gif",
      content_base64: base64("GIF89a-bytes"),
      request_id: "attach-request-1",
    });
    expect(result.isError).toBeFalsy();
    const markdown = `![chart \\[v2\\]\\.gif](attachment:${OBJECT})`;
    expect(result.structuredContent).toMatchObject({
      note_id: NOTE,
      object_id: OBJECT,
      shown_as: "image",
      markdown,
      revision: 4,
    });
    expect(calls.map((c) => [c.as, c.name])).toEqual([
      ["agent", "files:createUpload"],
      ["service", "files:admitUpload"],
      ["service", "files:finalize"],
      ["agent", "notes:edit"],
    ]);
    expect(calls[0]!.args).toEqual({
      noteId: NOTE,
      name: "chart [v2].gif",
      mimeType: "image/gif",
      size: 12,
      sha256: hash,
      requestId: "attach-request-1",
    });
    expect(calls[3]!.args).toEqual({
      noteId: NOTE,
      edits: [{ type: "append", markdown }],
      requestId: "attach-request-1",
    });
    expect(await (await r2.bucket.get(`objects/${OBJECT}`))!.text()).toBe(
      "GIF89a-bytes",
    );
  });

  it("inserts other files as file blocks after a chosen block", async () => {
    await granting("%PDF-1.7", "application/pdf");
    const result = await attach({
      filename: "q3.pdf",
      mime_type: "application/pdf",
      content_base64: base64("%PDF-1.7"),
      after_block_id: "abc123",
    });
    expect(result.isError).toBeFalsy();
    expect(calls.at(-1)!.args.edits).toEqual([
      {
        type: "insert_after",
        block_id: "abc123",
        markdown: `[q3\\.pdf](attachment:${OBJECT}){type=application/pdf size=8}`,
      },
    ]);
  });

  it("does not upload again when the request already finished", async () => {
    await granting("abc", "text/plain", "ready");
    const result = await attach({
      filename: "a.txt",
      mime_type: "text/plain",
      content_base64: base64("abc"),
      request_id: "attach-request-2",
    });
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.name)).toEqual([
      "files:createUpload",
      "notes:edit",
    ]);
  });

  it("checks the base64 and the size limit before calling anything", async () => {
    for (const content of [
      "data:image/png;base64,AAAA",
      "not base64!",
      "abc",
      "",
    ]) {
      const result = await attach({
        filename: "a.png",
        mime_type: "image/png",
        content_base64: content,
      });
      expect(result.isError).toBe(true);
    }
    const big = await attach({
      filename: "a.bin",
      mime_type: "application/octet-stream",
      // One byte over the limit, as valid base64.
      content_base64: "A".repeat(Math.ceil((ATTACH_MAX_BYTES + 1) / 3) * 4),
    });
    expect(big.isError).toBe(true);
    expect(big.content[0]!.text).toMatch(/larger than 2 MB/);
    expect(calls).toEqual([]);
  });

  it("reports storage trouble as retryable with the same request_id", async () => {
    await granting("abc", "image/png");
    serviceHandlers.set(fns.files.admitUpload, () => {
      throw new ConvexCallError({ kind: "uncertain", message: "down" });
    });
    const result = await attach({
      filename: "a.png",
      mime_type: "image/png",
      content_base64: base64("abc"),
      request_id: "attach-request-3",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "unavailable", retryable: true },
    });
    expect(calls.some((c) => c.name === "notes:edit")).toBe(false);
  });

  it("says when a request_id's upload expired, or files are not configured", async () => {
    await granting("abc", "image/png", "failed");
    const failed = await attach({
      filename: "a.png",
      mime_type: "image/png",
      content_base64: base64("abc"),
      request_id: "attach-request-4",
    });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toMatch(/new request_id/);
    withFiles = false;
    calls = [];
    const off = await attach({
      filename: "a.png",
      mime_type: "image/png",
      content_base64: base64("abc"),
    });
    expect(off.isError).toBe(true);
    expect(off.content[0]!.text).toMatch(/not configured/);
    expect(calls).toEqual([]);
  });

  it("passes Convex refusals through as tool errors", async () => {
    agentHandlers.set(fns.files.createUpload, () => {
      throw new ConvexCallError({
        kind: "backend",
        code: "denied",
        message: "This action needs edit access to the note.",
      });
    });
    const result = await attach({
      filename: "a.png",
      mime_type: "image/png",
      content_base64: base64("abc"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/^Error \(denied\): This action/);
  });
});
