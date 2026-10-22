#!/usr/bin/env node
// End-to-end check of attachments (port plan B1) against real services: a
// running `wrangler dev --test-scheduled --persist-to <dir>` (local R2
// simulation) and a Convex deployment running this branch's functions.
//
//   SERVICE_KEY_TRUSTED=1 (default): the deployment trusts the Worker's
//     signing key, so the Worker finalizes uploads and sweeps deletions
//     itself. Use a local backend configured as in the README.
//   SERVICE_KEY_TRUSTED=0: the deployment does not trust this Worker's key
//     (for example the shared dev deployment, whose key is not available
//     locally). The script then checks that the Worker's upload is refused,
//     finalizes through `npx convex run --identity` as the file service, and
//     places the bytes in the local bucket with `wrangler r2 object put`.
//
// Prints only non-secret progress. Creates disposable accounts each run.
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../notes-backend/convex/_generated/api.js";

const WORKER = process.env.WORKER_URL ?? "http://localhost:8787";
const CONVEX_URL = process.env.CONVEX_URL ?? "http://127.0.0.1:3228";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "http://127.0.0.1:3229";
const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "http://localhost:5178";
const ISSUER = process.env.AGENT_JWT_ISSUER ?? "http://localhost:8787";
const TRUSTED = process.env.SERVICE_KEY_TRUSTED !== "0";
const R2_PERSIST = process.env.R2_PERSIST_TO;
const BACKEND_DIR =
  process.env.NOTES_BACKEND_DIR ??
  new URL("../../notes-backend", import.meta.url).pathname;
const EDGE_DIR = new URL("..", import.meta.url).pathname;
const run = promisify(execFile);

let step = 0;
function log(message) {
  console.log(`[files-e2e ${String(++step).padStart(2, "0")}] ${message}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
const quiet = { logger: false };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.7\n% files e2e\n");
const HTML = Buffer.from("<script>alert(1)</script>");

async function convexRun(fn, args, extra = []) {
  const { stdout } = await run(
    "npx",
    ["convex", "run", fn, JSON.stringify(args), ...extra],
    { cwd: BACKEND_DIR, env: process.env, maxBuffer: 1 << 20 },
  );
  const start = stdout.search(/[[{]/);
  return start < 0 ? null : JSON.parse(stdout.slice(start));
}

/** A disposable account, signed in through Better Auth; returns a client and its Convex JWT. */
async function createPerson(name) {
  const email = `files-e2e-${randomBytes(6).toString("hex")}@example.test`;
  const password = randomBytes(24).toString("base64url");
  const { token } = await convexRun("provision:setupOwner", { email });
  const anonymous = new ConvexHttpClient(CONVEX_URL, quiet);
  await anonymous.action(api.invitations.accept, { token, name, password });
  const signIn = await fetch(`${CONVEX_SITE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: SITE_ORIGIN,
      "Better-Auth-Cookie": "",
    },
    body: JSON.stringify({ email, password }),
  });
  assert(signIn.ok, `sign-in succeeded (HTTP ${signIn.status})`);
  const cookie = (signIn.headers.get("set-better-auth-cookie") ?? "")
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map((part) => part.split(";")[0].trim())
    .join("; ");
  const tokenResponse = await fetch(
    `${CONVEX_SITE_URL}/api/auth/convex/token`,
    { headers: { Origin: SITE_ORIGIN, "Better-Auth-Cookie": cookie } },
  );
  assert(tokenResponse.ok, `Convex token issued (${tokenResponse.status})`);
  const { token: jwt } = await tokenResponse.json();
  const client = new ConvexHttpClient(CONVEX_URL, quiet);
  client.setAuth(jwt);
  return { client, jwt };
}

async function expectError(promise, pattern, message) {
  try {
    await promise;
  } catch (error) {
    assert(pattern.test(String(error?.data?.message ?? error)), message);
    return;
  }
  throw new Error(`Assertion failed: ${message} (no error)`);
}

function put(objectId, ticket, body, headers = {}) {
  return fetch(`${WORKER}/files/upload/${objectId}`, {
    method: "PUT",
    headers: {
      ...(ticket ? { Authorization: `Bearer ${ticket}` } : {}),
      ...headers,
    },
    body,
  });
}

function read(path, jwt, method = "GET") {
  return fetch(`${WORKER}${path}`, {
    method,
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
  });
}

async function r2Object(objectId) {
  try {
    const { stdout } = await run(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "get",
        `palladian-notes-files/objects/${objectId}`,
        "--local",
        "--persist-to",
        R2_PERSIST,
        "--pipe",
      ],
      { cwd: EDGE_DIR, encoding: "buffer", maxBuffer: 1 << 26 },
    );
    return stdout;
  } catch {
    return null;
  }
}

const SERVICE_IDENTITY = JSON.stringify({
  issuer: ISSUER,
  subject: "service:files",
});

/** Upload bytes for a ticket through the Worker (or, untrusted, the fallback). */
async function upload(granted, bytes) {
  const response = await put(granted.objectId, granted.ticket, bytes);
  if (TRUSTED) {
    assert(response.status === 200, `upload accepted (${response.status})`);
    const body = await response.json();
    assert(
      body.state === "ready" && body.sha256 === sha256(bytes),
      "upload is ready with the right hash",
    );
    return;
  }
  assert(
    response.status === 503,
    `the Worker's untrusted service key is refused (${response.status})`,
  );
  const dir = await mkdtemp(join(tmpdir(), "files-e2e-"));
  try {
    await writeFile(join(dir, "bytes"), bytes);
    await run(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "put",
        `palladian-notes-files/objects/${granted.objectId}`,
        "--file",
        join(dir, "bytes"),
        "--local",
        "--persist-to",
        R2_PERSIST,
      ],
      { cwd: EDGE_DIR },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const done = await convexRun(
    "files:finalize",
    {
      objectId: granted.objectId,
      ticket: granted.ticket,
      size: bytes.length,
      sha256: sha256(bytes),
    },
    ["--identity", SERVICE_IDENTITY],
  );
  assert(done?.status === "ready", "finalized as the file service");
}

async function main() {
  log(
    `worker ${WORKER}, convex ${CONVEX_URL}, service key ${TRUSTED ? "trusted" : "not trusted"}`,
  );
  assert(R2_PERSIST, "R2_PERSIST_TO names wrangler dev's --persist-to");
  const ada = await createPerson("Ada");
  const ben = await createPerson("Ben");
  log("two disposable accounts signed in through Better Auth");

  const note = await ada.client.mutation(api.notes.createFromMarkdown, {
    markdown: "Files e2e\n\nA note with attachments.",
  });
  const noteId = note.noteId;
  const requestId = randomUUID();
  const ticketArgs = {
    noteId,
    name: "pixel.png",
    mimeType: "image/png",
    size: PIXEL.length,
    sha256: sha256(PIXEL),
    requestId,
  };
  const granted = await ada.client.mutation(api.files.createUpload, ticketArgs);
  assert(granted.state === "pending" && granted.ticket, "ticket issued");
  await expectError(
    ben.client.mutation(api.files.createUpload, {
      ...ticketArgs,
      requestId: randomUUID(),
    }),
    /not found/i,
    "no ticket for someone without access",
  );
  log("Ada got an upload ticket for her note; Ben, without access, did not");

  assert(
    (await put(granted.objectId, null, PIXEL)).status === 401,
    "no ticket",
  );
  const wrong = Buffer.from(PIXEL);
  wrong[wrong.length - 1] ^= 1;
  const mismatch = await put(granted.objectId, granted.ticket, wrong);
  if (TRUSTED) {
    assert(
      mismatch.status === 422,
      `changed bytes refused (${mismatch.status})`,
    );
    assert(
      (await mismatch.json()).error === "hash_mismatch",
      "reported as a hash mismatch",
    );
    const short = await put(
      granted.objectId,
      granted.ticket,
      PIXEL.subarray(1),
    );
    assert(short.status === 422, "short body refused");
    log("upload without a ticket → 401; changed or short bytes → 422");
  }

  await upload(granted, PIXEL);
  if (TRUSTED) {
    assert(
      (await put(granted.objectId, granted.ticket, PIXEL)).status === 200,
      "a retry with the same ticket succeeds",
    );
  }
  const replay = await ada.client.mutation(api.files.createUpload, ticketArgs);
  assert(
    replay.objectId === granted.objectId && replay.state === "ready",
    "a retried request returns the same, ready object",
  );
  const stored = await r2Object(granted.objectId);
  assert(stored && stored.equals(PIXEL), "R2 holds exactly the uploaded bytes");
  log(
    TRUSTED
      ? "the Worker checked, stored and finalized the PNG; retries made no second object"
      : "the Worker's upload was refused by the deployment (untrusted service key); finalized through the CLI as the file service instead",
  );

  const path = `/files/notes/${noteId}/${granted.objectId}`;
  const before = await read(path, ada.jwt);
  assert(before.status === 404, "not readable before the note references it");
  const content = await ada.client.query(api.notes.content, { noteId });
  await ada.client.mutation(api.notes.edit, {
    noteId,
    expectedRevision: content.revision,
    edits: [
      { type: "append", markdown: `![pixel](attachment:${granted.objectId})` },
    ],
  });
  const image = await read(path, ada.jwt);
  assert(image.status === 200, `owner reads the image (${image.status})`);
  assert(
    Buffer.from(await image.arrayBuffer()).equals(PIXEL),
    "the bytes match",
  );
  const headers = Object.fromEntries(image.headers);
  assert(headers["content-type"] === "image/png", "served as image/png");
  assert(headers["content-disposition"].startsWith("inline;"), "inline");
  assert(headers["x-content-type-options"] === "nosniff", "nosniff");
  assert(
    headers["content-security-policy"] === "default-src 'none'; sandbox",
    "sandboxing CSP",
  );
  assert(headers["cache-control"] === "private, no-store", "no-store");
  const head = await read(path, ada.jwt, "HEAD");
  assert(
    head.status === 200 &&
      head.headers.get("content-length") === String(PIXEL.length),
    "HEAD answers with headers",
  );
  log(
    "after Ada added it to the note: 200 image/png inline, nosniff, sandbox CSP, no-store; HEAD too",
  );

  assert((await read(path, ben.jwt)).status === 404, "Ben cannot read it");
  assert((await read(path, null)).status === 401, "signed out → 401");
  assert(
    (await read(path, "not.a.token")).status === 401,
    "an invalid token → 401",
  );
  const bens = await ben.client.mutation(api.notes.createFromMarkdown, {
    markdown: `Ben's copy\n\n![x](attachment:${granted.objectId})`,
  });
  assert(
    (await read(`/files/notes/${bens.noteId}/${granted.objectId}`, ben.jwt))
      .status === 404,
    "referencing the ID in his own note grants Ben nothing",
  );
  log(
    "refused: Ben (no access) → 404, signed out and invalid token → 401, Ben's own note naming the object → 404",
  );

  for (const [name, mimeType, bytes] of [
    ["report.pdf", "application/pdf", PDF],
    ["page.html", "text/html", HTML],
  ]) {
    const file = await ada.client.mutation(api.files.createUpload, {
      noteId,
      name,
      mimeType,
      size: bytes.length,
      sha256: sha256(bytes),
    });
    await upload(file, bytes);
    const current = await ada.client.query(api.notes.content, { noteId });
    await ada.client.mutation(api.notes.edit, {
      noteId,
      expectedRevision: current.revision,
      edits: [
        {
          type: "append",
          markdown: `[${name}](attachment:${file.objectId}){type=${mimeType} size=${bytes.length}}`,
        },
      ],
    });
    const download = await read(
      `/files/notes/${noteId}/${file.objectId}`,
      ada.jwt,
    );
    assert(download.status === 200, `${name} readable`);
    assert(
      download.headers.get("content-type") === "application/octet-stream" &&
        download.headers.get("content-disposition").startsWith("attachment;"),
      `${name} is an octet-stream download`,
    );
  }
  const objects = await ada.client.query(api.files.noteObjects, { noteId });
  assert(objects.length === 3, "the note lists three objects");
  log(
    "a PDF and an HTML file download as application/octet-stream attachments",
  );

  const { token } = await ada.client.mutation(api.publishing.publish, {
    noteId,
  });
  const publicPath = `/files/public/${token}/${granted.objectId}`;
  assert(
    (await read(publicPath, null)).status === 200,
    "public link serves it",
  );
  // Uploaded for the note but never put in it.
  const other = await ada.client.mutation(api.files.createUpload, {
    noteId,
    name: "other.png",
    mimeType: "image/png",
    size: PIXEL.length,
    sha256: sha256(PIXEL),
  });
  await upload(other, PIXEL);
  assert(
    (await read(`/files/public/${token}/${other.objectId}`, null)).status ===
      404,
    "an object outside the published content is not served",
  );
  await ada.client.mutation(api.notes.trash, { noteId });
  assert(
    (await read(publicPath, null)).status === 404,
    "unavailable while the note is in Trash",
  );
  assert(
    (await read(path, ada.jwt)).status === 200,
    "the owner still reads it from Trash",
  );
  await ada.client.mutation(api.notes.restore, { noteId });
  assert((await read(publicPath, null)).status === 200, "back after restore");
  log(
    "public link: serves the published image, not other objects; 404 while trashed, back after restore",
  );

  const latest = await ada.client.query(api.notes.content, { noteId });
  await ada.client.mutation(api.notes.edit, {
    noteId,
    expectedRevision: latest.revision,
    edits: [{ type: "replace_all", markdown: "Files e2e\n\nNo attachments." }],
  });
  assert(
    (await read(publicPath, null)).status === 404,
    "removed from the content: no longer public",
  );
  assert(
    (await read(path, ada.jwt)).status === 200,
    "an editor still reads it through the note's history",
  );
  const remaining = await ada.client.query(api.files.noteObjects, { noteId });
  assert(remaining.length === 0, "no current objects");
  log(
    "after removing the attachments: not public, still readable by the editor through history",
  );

  if (TRUSTED) {
    const spare = await ada.client.mutation(api.files.createUpload, {
      noteId,
      name: "spare.png",
      mimeType: "image/png",
      size: PIXEL.length,
      sha256: sha256(PIXEL),
    });
    await upload(spare, PIXEL);
    assert(await r2Object(spare.objectId), "spare bytes stored");
    await ada.client.mutation(api.files.cancelUpload, {
      objectId: spare.objectId,
    });
    const sweep = await fetch(
      `${WORKER}/cdn-cgi/handler/scheduled?cron=23+4+*+*+*`,
    );
    assert(sweep.ok, `scheduled handler ran (${sweep.status})`);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      gone = (await r2Object(spare.objectId)) === null;
      if (!gone) await new Promise((r) => setTimeout(r, 500));
    }
    assert(gone, "the sweep deleted the cancelled object's bytes from R2");
    const queue = await convexRun("files:deletionBatch", { limit: 100 }, [
      "--identity",
      SERVICE_IDENTITY,
    ]);
    assert(
      !queue.some((row) => row.key === `objects/${spare.objectId}`),
      "the deletion was confirmed",
    );
    log(
      "a cancelled upload's bytes were deleted from R2 by the scheduled sweep and confirmed in Convex",
    );
  }
  log("PASS");
}

main().catch((error) => {
  console.error(
    `[files-e2e] FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
