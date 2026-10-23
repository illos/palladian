import { getFunctionName, type FunctionReference } from "convex/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ConvexCallError, type ConvexCaller } from "../src/convex.ts";
import { fns } from "../src/convex-api.ts";
import {
  fileHeaders,
  handleFiles,
  MAX_UPLOAD_BYTES,
  sha256Hex,
  sweepDeletedFiles,
  type FilesDeps,
  type FilesEnv,
} from "../src/files.ts";
import worker from "../src/index.ts";
import { localR2 } from "./local-r2.mjs";

/**
 * The /files routes against wrangler's local R2 simulation, with Convex
 * replaced by fakes that answer like apps/notes-backend/convex/files.ts.
 */

type Handler = (args: Record<string, unknown>) => unknown;
const ORIGIN = "https://notes.example";
const TICKET = "t".repeat(43);
const TOKEN = "header.payload.signature";

let r2: Awaited<ReturnType<typeof localR2>>;
let env: FilesEnv;
let service: Map<unknown, Handler>;
let reads: Map<unknown, Handler>;
let calls: { as: string; name: string; args: unknown }[];

function fake(as: string, handlers: () => Map<unknown, Handler>): ConvexCaller {
  const run = async (fn: unknown, args: unknown) => {
    calls.push({
      as,
      name: getFunctionName(fn as FunctionReference<"query" | "mutation">),
      args,
    });
    const handler = handlers().get(fn);
    if (!handler) throw new Error("unexpected call");
    return handler(args as Record<string, unknown>);
  };
  return { query: run as never, mutation: run as never };
}

const deps: FilesDeps = {
  service: async () => fake("service", () => service),
  caller: (_env, token) => fake(token ?? "anonymous", () => reads),
};

let counter = 0;
function newId() {
  return `obj${String(++counter).padStart(13, "0")}abcdef`;
}
const bytes = (text: string) => new TextEncoder().encode(text);

function put(objectId: string, body: BodyInit | null, headers = {}) {
  return handleFiles(
    new Request(`${ORIGIN}/files/upload/${objectId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TICKET}`, ...headers },
      body,
    }),
    env,
    deps,
  );
}

function get(path: string, init: RequestInit = {}) {
  return handleFiles(new Request(`${ORIGIN}${path}`, init), env, deps);
}

/** Convex expects these bytes for the ticket; finalize answers `finalized`. */
async function expecting(
  content: string,
  mimeType = "image/png",
  finalized: { status: string } | (() => never) = { status: "ready" },
) {
  const hash = await sha256Hex(bytes(content));
  service.set(fns.files.admitUpload, () => ({
    status: "pending",
    size: bytes(content).byteLength,
    sha256: hash,
    mimeType,
    leaseUntil: Date.now() + 15 * 60_000,
  }));
  service.set(
    fns.files.finalize,
    typeof finalized === "function" ? finalized : () => finalized,
  );
  return hash;
}

beforeAll(async () => {
  r2 = await localR2();
});
afterAll(async () => {
  await r2.dispose();
});
beforeEach(() => {
  env = {
    FILES: r2.bucket,
    CONVEX_URL: "https://example-123.convex.cloud",
    AGENT_JWT_PRIVATE_KEY: "",
    AGENT_JWT_ISSUER: ORIGIN,
  };
  service = new Map();
  reads = new Map();
  calls = [];
});

describe("PUT /files/upload/<objectId>", () => {
  it("checks the bytes, writes R2 and finalizes", async () => {
    const id = newId();
    const hash = await expecting("png bytes");
    const response = await put(id, "png bytes");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object_id: id,
      state: "ready",
      size: 9,
      sha256: hash,
    });
    const stored = await r2.bucket.get(`objects/${id}`);
    expect(await stored!.text()).toBe("png bytes");
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
    expect(calls.map((c) => [c.as, c.name, c.args])).toEqual([
      ["service", "files:admitUpload", { objectId: id, ticket: TICKET }],
      [
        "service",
        "files:finalize",
        { objectId: id, ticket: TICKET, size: 9, sha256: hash },
      ],
    ]);
  });

  it("a retry with the same ticket writes the same key or nothing", async () => {
    const id = newId();
    await expecting("abc");
    expect((await put(id, "abc")).status).toBe(200);
    // Lost response, still pending in Convex: the same key again.
    expect((await put(id, "abc")).status).toBe(200);
    const listed = await r2.bucket.list({ prefix: `objects/${id}` });
    expect(listed.objects).toHaveLength(1);
    // Already ready: nothing is read or written.
    service.set(fns.files.admitUpload, () => ({
      status: "ready",
      size: 3,
      sha256: "x",
    }));
    calls = [];
    expect((await put(id, "abc")).status).toBe(200);
    expect(calls.map((c) => c.name)).toEqual(["files:admitUpload"]);
  });

  it("refuses bytes that differ from the ticket, before writing", async () => {
    const id = newId();
    await expecting("exact");
    for (const [body, headers] of [
      ["exact plus", {}],
      ["exac", {}],
      ["other", {}],
    ] as const) {
      const response = await put(id, body, headers);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: body === "other" ? "hash_mismatch" : "size_mismatch",
      });
    }
    expect(await r2.bucket.head(`objects/${id}`)).toBeNull();
    expect(calls.some((c) => c.name === "files:finalize")).toBe(false);
  });

  it("refuses a body declared larger than 25 MB without asking Convex", async () => {
    const response = await handleFiles(
      new Request(`${ORIGIN}/files/upload/${newId()}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TICKET}`,
          "Content-Length": String(MAX_UPLOAD_BYTES + 1),
        },
      }),
      env,
      deps,
    );
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("needs a well-formed ticket that Convex knows", async () => {
    const id = newId();
    for (const authorization of [
      null,
      "Bearer",
      "Basic abc",
      "Bearer short",
      "Bearer has space",
    ]) {
      const response = await handleFiles(
        new Request(`${ORIGIN}/files/upload/${id}`, {
          method: "PUT",
          ...(authorization
            ? { headers: { Authorization: authorization } }
            : {}),
          body: "x",
        }),
        env,
        deps,
      );
      expect(response.status).toBe(401);
    }
    expect(calls).toEqual([]);
    service.set(fns.files.admitUpload, () => ({ status: "denied" }));
    expect((await put(id, "x")).status).toBe(404);
    service.set(fns.files.admitUpload, () => ({ status: "gone" }));
    const gone = await put(id, "x");
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: "expired" });
    expect((await put("../../etc", "x")).status).toBe(404);
  });

  it("removes what it wrote when the object will never be ready", async () => {
    const id = newId();
    await expecting("late", "image/png", { status: "gone" });
    expect((await put(id, "late")).status).toBe(410);
    expect(await r2.bucket.head(`objects/${id}`)).toBeNull();
  });

  it("keeps the bytes when finalizing has an unknown outcome", async () => {
    const id = newId();
    await expecting("maybe", "image/png", () => {
      throw new ConvexCallError({ kind: "uncertain", message: "timeout" });
    });
    const response = await put(id, "maybe");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await r2.bucket.head(`objects/${id}`)).not.toBeNull();
  });

  it("answers 503 when Convex cannot be asked", async () => {
    service.set(fns.files.admitUpload, () => {
      throw new ConvexCallError({ kind: "uncertain", message: "down" });
    });
    expect((await put(newId(), "x")).status).toBe(503);
    expect(
      (
        await handleFiles(
          new Request(`${ORIGIN}/files/upload/${newId()}`, { method: "GET" }),
          env,
          deps,
        )
      ).status,
    ).toBe(405);
  });
});

describe("GET /files/notes/<noteId>/<objectId>", () => {
  const NOTE = "note0000000000000001";
  async function stored(content: string, mimeType: string, name: string) {
    const id = newId();
    await r2.bucket.put(`objects/${id}`, bytes(content));
    reads.set(fns.files.authorizeRead, () => ({
      access: "granted",
      name,
      mimeType,
      size: bytes(content).byteLength,
      sha256: "f".repeat(64),
    }));
    return id;
  }
  const read = (id: string, init: RequestInit = {}) =>
    get(`/files/notes/${NOTE}/${id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      ...init,
    });

  it("serves images inline once Convex grants the caller access", async () => {
    const id = await stored("GIF89a", "image/gif", "cat.gif");
    const response = await read(id);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("GIF89a");
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/gif",
      "content-disposition": `inline; filename="cat.gif"; filename*=UTF-8''cat.gif`,
      "content-length": "6",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, no-store",
      etag: `"${"f".repeat(64)}"`,
    });
    // Convex was asked with the caller's own token.
    expect(calls).toEqual([
      {
        as: TOKEN,
        name: "files:authorizeRead",
        args: { noteId: NOTE, objectId: id },
      },
    ]);
  });

  it("downloads everything else as octet-stream", async () => {
    for (const mimeType of [
      "application/pdf",
      "text/html",
      "image/svg+xml",
      "application/javascript",
      "image/heic",
    ]) {
      const id = await stored("<script>alert(1)</script>", mimeType, "x");
      const response = await read(id);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toMatch(
        /^attachment; /,
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("encodes file names safely", () => {
    const headers = fileHeaders(
      {
        name: 'Ré"sumé\\ (final)*.pdf',
        mimeType: "application/pdf",
        size: 1,
        sha256: "a",
      },
      1,
    );
    expect(headers.get("content-disposition")).toBe(
      `attachment; filename="R__sum__ (final)*.pdf"; filename*=UTF-8''R%C3%A9%22sum%C3%A9%5C%20%28final%29%2A.pdf`,
    );
  });

  it("answers HEAD with headers only", async () => {
    const id = await stored("abcd", "image/webp", "w.webp");
    const response = await read(id, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("4");
    expect(await response.text()).toBe("");
  });

  it("refuses without access, and asks for a fresh token when needed", async () => {
    const id = await stored("x", "image/png", "x.png");
    expect((await get(`/files/notes/${NOTE}/${id}`)).status).toBe(401);
    reads.set(fns.files.authorizeRead, () => ({ access: "denied" }));
    expect((await read(id)).status).toBe(404);
    reads.set(fns.files.authorizeRead, () => ({ access: "unauthenticated" }));
    expect((await read(id)).status).toBe(401);
    reads.set(fns.files.authorizeRead, () => {
      throw new ConvexCallError({
        kind: "rejected",
        credentials: true,
        message: "expired",
      });
    });
    expect((await read(id)).status).toBe(401);
    reads.set(fns.files.authorizeRead, () => {
      throw new ConvexCallError({ kind: "uncertain", message: "down" });
    });
    expect((await read(id)).status).toBe(503);
    calls = [];
    expect((await read("BAD")).status).toBe(404);
    expect((await get(`/files/notes/x/${id}`)).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await read(id, { method: "POST" })).status).toBe(405);
  });

  it("reports missing bytes as not found", async () => {
    reads.set(fns.files.authorizeRead, () => ({
      access: "granted",
      name: "gone.png",
      mimeType: "image/png",
      size: 1,
      sha256: "a",
    }));
    expect((await read(newId())).status).toBe(404);
  });
});

describe("GET /files/public/<token>/<objectId>", () => {
  const LINK = "L".repeat(43);
  it("serves only what Convex allows for the link, signed out", async () => {
    const id = newId();
    await r2.bucket.put(`objects/${id}`, bytes("public"));
    reads.set(fns.files.authorizePublicRead, () => ({
      name: "p.jpg",
      mimeType: "image/jpeg",
      size: 6,
      sha256: "b",
    }));
    const response = await get(`/files/public/${LINK}/${id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("public");
    expect(calls).toEqual([
      {
        as: "anonymous",
        name: "files:authorizePublicRead",
        args: { token: LINK, objectId: id },
      },
    ]);
    reads.set(fns.files.authorizePublicRead, () => null);
    expect((await get(`/files/public/${LINK}/${id}`)).status).toBe(404);
    calls = [];
    expect((await get(`/files/public/short/${id}`)).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("routing and cleanup", () => {
  it("answers unknown file paths, and 503 without a bucket", async () => {
    expect((await get("/files/other")).status).toBe(404);
    expect((await get("/files/notes/a")).status).toBe(404);
    const { FILES: _files, ...unbound } = env;
    const response = await handleFiles(
      new Request(`${ORIGIN}/files/upload/${newId()}`, { method: "PUT" }),
      unbound,
      deps,
    );
    expect(response.status).toBe(503);
  });

  it("routes /files before the OAuth provider", async () => {
    // No OAuth storage is bound: reaching the provider would throw.
    const response = await worker.fetch(
      new Request(`${ORIGIN}/files/upload/${newId()}`, { method: "PUT" }),
      {
        CONVEX_URL: env.CONVEX_URL,
        AGENT_JWT_ISSUER: ORIGIN,
        AGENT_JWT_PRIVATE_KEY: "",
        PUBLIC_ORIGIN: ORIGIN,
      } as never,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(503);
  });

  it("deletes queued bytes and confirms them", async () => {
    const ids = [newId(), newId()];
    for (const id of ids) await r2.bucket.put(`objects/${id}`, bytes("old"));
    const keep = newId();
    await r2.bucket.put(`objects/${keep}`, bytes("keep"));
    let queue = [
      { id: "d1", key: `objects/${ids[0]}` },
      { id: "d2", key: `objects/${ids[1]}` },
      { id: "d3", key: "../not-a-key" },
    ];
    service.set(fns.files.deletionBatch, () => queue);
    service.set(fns.files.confirmDeletions, (args) => {
      const done = new Set(args.ids as string[]);
      queue = queue.filter((row) => !done.has(row.id));
      return null;
    });
    expect(await sweepDeletedFiles(env, deps)).toBe(2);
    for (const id of ids)
      expect(await r2.bucket.head(`objects/${id}`)).toBeNull();
    expect(await r2.bucket.head(`objects/${keep}`)).not.toBeNull();
    expect(queue).toEqual([]);
  });
});

describe("review round 1", () => {
  /** Date.now() as the code sees it, moved forward while a body is read. */
  function clock() {
    const start = Date.now();
    const state = { offset: 0 };
    const spy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => start + state.offset);
    return { state, restore: () => spy.mockRestore() };
  }
  /** A body whose bytes arrive after `delay` milliseconds of the code's time. */
  function slowBody(content: string, state: { offset: number }, delay: number) {
    // highWaterMark 0: nothing is pulled until the Worker reads the body.
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.offset += delay;
          controller.enqueue(bytes(content));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
  }
  function putStream(objectId: string, body: ReadableStream, using = deps) {
    return handleFiles(
      new Request(`${ORIGIN}/files/upload/${objectId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TICKET}` },
        body,
        duplex: "half",
      } as RequestInit),
      env,
      using,
    );
  }

  it("F3: no write once the admission's lease has passed", async () => {
    const id = newId();
    await expecting("late bytes");
    const { state, restore } = clock();
    try {
      const response = await putStream(
        id,
        slowBody("late bytes", state, 15 * 60_000 + 1),
      );
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: "too_slow" });
    } finally {
      restore();
    }
    expect(await r2.bucket.head(`objects/${id}`)).toBeNull();
    expect(calls.map((c) => c.name)).toEqual(["files:admitUpload"]);
  });

  it("F5: a slow upload finalizes with a fresh service token", async () => {
    const id = newId();
    await expecting("slow bytes");
    // Each client works for 60 s after it is made, like its service JWT.
    let made = 0;
    const expiring: FilesDeps = {
      service: async () => {
        const created = Date.now();
        made++;
        const inner = fake("service", () => service);
        const guard = <R>(call: () => Promise<R>): Promise<R> => {
          if (Date.now() - created > 60_000)
            throw new ConvexCallError({
              kind: "rejected",
              credentials: true,
              message: "The service token expired.",
            });
          return call();
        };
        return {
          query: ((fn: never, args: never) =>
            guard(() => inner.query(fn, args))) as never,
          mutation: ((fn: never, args: never) =>
            guard(() => inner.mutation(fn, args))) as never,
        };
      },
    };
    const { state, restore } = clock();
    try {
      const response = await putStream(
        id,
        slowBody("slow bytes", state, 61_000),
        expiring,
      );
      expect(response.status).toBe(200);
    } finally {
      restore();
    }
    expect(made).toBe(2);
    expect(await (await r2.bucket.get(`objects/${id}`))!.text()).toBe(
      "slow bytes",
    );
  });

  it("F5: the deletion sweep uses a fresh service token per call", async () => {
    let made = 0;
    let queue = Array.from({ length: 150 }, (_, i) => ({
      id: `d${i}`,
      key: `objects/${newId()}`,
    }));
    service.set(fns.files.deletionBatch, (args) =>
      queue.slice(0, Number(args.limit)),
    );
    service.set(fns.files.confirmDeletions, (args) => {
      const done = new Set(args.ids as string[]);
      queue = queue.filter((row) => !done.has(row.id));
      return null;
    });
    const counting: FilesDeps = {
      service: async () => {
        made++;
        return fake("service", () => service);
      },
    };
    expect(await sweepDeletedFiles(env, counting)).toBe(150);
    // Two batches: a list and a confirmation each, each with its own token.
    expect(made).toBe(4);
  });
});

describe("review round 2", () => {
  /** Date.now() as the code sees it. */
  function clock() {
    const start = Date.now();
    const state = { offset: 0 };
    const spy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => start + state.offset);
    return { state, restore: () => spy.mockRestore() };
  }
  /** The local bucket, but each write completes `delay` ms later. */
  function slowWrites(state: { offset: number }, delay: number): R2Bucket {
    const bucket = r2.bucket;
    return {
      head: (key: string) => bucket.head(key),
      get: (key: string) => bucket.get(key),
      delete: (keys: string | string[]) => bucket.delete(keys),
      list: (options?: R2ListOptions) => bucket.list(options),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        const result = await bucket.put(...args);
        state.offset += delay;
        return result;
      },
    } as unknown as R2Bucket;
  }
  function putWith(files: R2Bucket, objectId: string, content: string) {
    return handleFiles(
      new Request(`${ORIGIN}/files/upload/${objectId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${TICKET}` },
        body: content,
      }),
      { ...env, FILES: files },
      deps,
    );
  }
  const LATE = 15 * 60_000 + 1;

  it("R2-2: a write landing after the lease, for a cancelled object, is removed", async () => {
    const id = newId();
    await expecting("late write", "image/png", { status: "gone" });
    const { state, restore } = clock();
    try {
      const response = await putWith(slowWrites(state, LATE), id, "late write");
      expect(response.status).toBe(410);
    } finally {
      restore();
    }
    expect(await r2.bucket.head(`objects/${id}`)).toBeNull();
  });

  it("R2-2: a late write is removed even when finalize does not say why", async () => {
    const id = newId();
    await expecting("late denied", "image/png", { status: "denied" });
    const { state, restore } = clock();
    try {
      expect(
        (await putWith(slowWrites(state, LATE), id, "late denied")).status,
      ).toBe(404);
    } finally {
      restore();
    }
    expect(await r2.bucket.head(`objects/${id}`)).toBeNull();
  });

  it("R2-2: a late write to an object that is ready stays (a concurrent retry finished it)", async () => {
    const id = newId();
    await expecting("late but ready");
    const { state, restore } = clock();
    try {
      expect(
        (await putWith(slowWrites(state, LATE), id, "late but ready")).status,
      ).toBe(200);
    } finally {
      restore();
    }
    expect(await r2.bucket.head(`objects/${id}`)).not.toBeNull();
  });

  it("R2-2: an unknown finalize outcome keeps the bytes; the tombstone sweeps them if needed", async () => {
    const id = newId();
    await expecting("late unknown", "image/png", () => {
      throw new ConvexCallError({ kind: "uncertain", message: "lost" });
    });
    const { state, restore } = clock();
    try {
      expect(
        (await putWith(slowWrites(state, LATE), id, "late unknown")).status,
      ).toBe(503);
    } finally {
      restore();
    }
    expect(await r2.bucket.head(`objects/${id}`)).not.toBeNull();
  });

  it("R2-2: a Worker clock behind Convex's still cleans up when finalize refuses", async () => {
    const id = newId();
    const hash = await expecting("skewed", "image/png", { status: "gone" });
    // Convex's lease ends in 15 minutes by its clock; this Worker's clock
    // runs 20 minutes behind, so the lease looks open when the write ends.
    service.set(fns.files.admitUpload, () => ({
      status: "pending",
      size: bytes("skewed").byteLength,
      sha256: hash,
      mimeType: "image/png",
      leaseUntil: Date.now() + 35 * 60_000,
    }));
    const { state, restore } = clock();
    try {
      expect(
        (await putWith(slowWrites(state, 30 * 60_000), id, "skewed")).status,
      ).toBe(410);
    } finally {
      restore();
    }
    expect(await r2.bucket.head(`objects/${id}`)).toBeNull();
  });
});
