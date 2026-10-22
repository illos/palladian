/// <reference types="vite/client" />
import { markdownToDoc } from "@palladian/notes-core";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import authSchema from "../convex/betterAuth/schema";
import {
  FINALIZE_GRACE_MS,
  MAX_PENDING_UPLOADS,
  MAX_UPLOAD_BYTES,
  ORPHAN_TTL_MS,
  TICKET_TTL_MS,
} from "../convex/files";
import { MAX_NOTE_OBJECTS } from "../convex/references";
import schema from "../convex/schema";

const AGENT_ISSUER = "https://agent.test";
process.env.AGENT_JWT_ISSUER = AGENT_ISSUER;
const DAY = 86_400_000;
const modules = import.meta.glob([
  "../convex/**/*.ts",
  "!../convex/betterAuth/**",
]);
const authModules = import.meta.glob("../convex/betterAuth/**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}
type T = ReturnType<typeof setup>;
type As = ReturnType<T["withIdentity"]>;

async function human(t: T, name: string) {
  const now = Date.now();
  const email = name.toLowerCase() + "@example.com";
  const made = await t.run(async (ctx) => {
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name,
          email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    })) as { _id: string };
    const session = (await ctx.runMutation(
      components.betterAuth.adapter.create,
      {
        input: {
          model: "session",
          data: {
            userId: user._id,
            token: crypto.randomUUID(),
            expiresAt: now + 400 * DAY,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    )) as { _id: string };
    const principalId = await ctx.db.insert("principals", {
      kind: "human",
      name,
      email,
      authUserId: user._id,
      createdAt: now,
    });
    const notebookId = await ctx.db.insert("notebooks", {
      ownerId: principalId,
      name: "Notes",
      description: "",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("notebookSequences", { notebookId, seq: 0 });
    await ctx.db.patch(principalId, { defaultNotebookId: notebookId });
    return {
      id: principalId,
      notebookId,
      userId: user._id,
      sessionId: session._id,
    };
  });
  return {
    id: made.id,
    notebookId: made.notebookId,
    as: t.withIdentity({
      subject: made.userId,
      sessionId: made.sessionId,
      issuer: "https://site.test",
    }),
  };
}

async function agent(t: T, controllerId: Id<"principals">) {
  const made = await t.run(async (ctx) => {
    const agentId = await ctx.db.insert("principals", {
      kind: "agent",
      name: "Claude",
      controllerId,
      createdAt: Date.now(),
    });
    const connectionId = await ctx.db.insert("connections", {
      agentId,
      controllerId,
      clientId: "client",
      clientName: "Claude",
      redirectHost: "claude.ai",
      createdAt: Date.now(),
    });
    return { id: agentId, connectionId };
  });
  return {
    id: made.id,
    as: t.withIdentity({
      issuer: AGENT_ISSUER,
      subject: made.id,
      cid: made.connectionId,
    }),
  };
}

async function share(
  t: T,
  notebookId: Id<"notebooks">,
  principalId: Id<"principals">,
  role: "read" | "edit",
  by: Id<"principals">,
) {
  await t.run((ctx) =>
    ctx.db.insert("notebookMembers", {
      notebookId,
      principalId,
      role,
      grantedBy: by,
      createdAt: Date.now(),
    }),
  );
}

/** The Worker, as the file service. */
const service = (t: T) =>
  t.withIdentity({ issuer: AGENT_ISSUER, subject: "service:files" });

async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Target = { noteId: Id<"notes"> } | { notebookId: Id<"notebooks"> };

async function ticket(
  as: As,
  target: Target,
  bytes = "png bytes",
  extra: { requestId?: string; name?: string; mimeType?: string } = {},
) {
  return await as.mutation(api.files.createUpload, {
    ...target,
    name: extra.name ?? "photo.png",
    mimeType: extra.mimeType ?? "image/png",
    size: bytes.length,
    sha256: await sha256(bytes),
    ...(extra.requestId ? { requestId: extra.requestId } : {}),
  });
}

/** Ticket, then what the Worker does after checking the bytes. */
async function upload(t: T, as: As, target: Target, bytes = "png bytes") {
  const granted = await ticket(as, target, bytes);
  const done = await service(t).mutation(api.files.finalize, {
    objectId: granted.objectId,
    ticket: granted.ticket!,
    size: bytes.length,
    sha256: await sha256(bytes),
  });
  expect(done).toEqual({ status: "ready" });
  return granted.objectId;
}

function docJson(markdown: string) {
  return JSON.stringify(markdownToDoc(markdown).toJSON());
}

async function createNote(as: As, markdown: string, key = crypto.randomUUID()) {
  const { noteId } = await as.mutation(api.notes.create, {
    clientKey: key,
    doc: docJson(markdown),
  });
  return noteId;
}

async function replaceAll(as: As, noteId: Id<"notes">, markdown: string) {
  const content = (await as.query(api.notes.content, { noteId }))!;
  return await as.mutation(api.notes.edit, {
    noteId,
    expectedRevision: content.revision,
    edits: [{ type: "replace_all", markdown }],
  });
}

const image = (id: string) => `![](attachment:${id})`;

async function object(t: T, id: Id<"objects">) {
  return await t.run((ctx) => ctx.db.get(id));
}
async function refs(t: T, id: Id<"objects">) {
  return await t.run((ctx) =>
    ctx.db
      .query("objectRefs")
      .withIndex("by_object_and_current", (q) => q.eq("objectId", id))
      .collect(),
  );
}
async function deletions(t: T) {
  return (await t.run((ctx) => ctx.db.query("objectDeletions").collect())).map(
    (row) => row.key,
  );
}
const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("upload tickets", () => {
  test("need edit access to the note or notebook", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    const cy = await human(t, "Cy");
    const dee = await human(t, "Dee");
    await share(t, ada.notebookId, ben.id, "edit", ada.id);
    await share(t, ada.notebookId, cy.id, "read", ada.id);
    const noteId = await createNote(ada.as, "Trip");

    const owner = await ticket(ada.as, { noteId });
    expect(owner.state).toBe("pending");
    expect(owner.ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(owner.expiresAt).toBe(Date.now() + TICKET_TTL_MS);
    const editor = await ticket(ben.as, { noteId });
    // Objects belong to the note's owner, whoever uploads them.
    const row = (await object(t, editor.objectId))!;
    expect(row.ownerId).toBe(ada.id);
    expect(row.uploaderId).toBe(ben.id);
    // The ticket itself is never stored.
    expect(JSON.stringify(row)).not.toContain(editor.ticket!);

    await expect(ticket(cy.as, { noteId })).rejects.toThrow(/edit access/);
    await expect(ticket(dee.as, { noteId })).rejects.toThrow(/not found/);
    await expect(ticket(t, { noteId } as Target)).rejects.toThrow(/Sign in/);
    // New file notes: edit access to the notebook.
    expect((await ticket(ben.as, { notebookId: ada.notebookId })).state).toBe(
      "pending",
    );
    await expect(ticket(cy.as, { notebookId: ada.notebookId })).rejects.toThrow(
      /edit access/,
    );
  });

  test("agents get tickets through their own sharing only", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const claude = await agent(t, ada.id);
    const noteId = await createNote(ada.as, "Shared later");
    await expect(ticket(claude.as, { noteId })).rejects.toThrow(/not found/);
    await share(t, ada.notebookId, claude.id, "read", ada.id);
    await expect(ticket(claude.as, { noteId })).rejects.toThrow(/edit access/);
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("notebookMembers")
        .withIndex("by_notebook_and_principal", (q) =>
          q.eq("notebookId", ada.notebookId).eq("principalId", claude.id),
        )
        .unique();
      await ctx.db.patch(member!._id, { role: "edit" });
    });
    expect((await ticket(claude.as, { noteId })).state).toBe("pending");
  });

  test("validate the request", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Files");
    const base = {
      noteId,
      name: "a.pdf",
      mimeType: "application/pdf",
      size: 3,
      sha256: await sha256("abc"),
    };
    const create = (args: Partial<typeof base> & Record<string, unknown>) =>
      ada.as.mutation(api.files.createUpload, { ...base, ...args });
    await expect(create({ size: 0 })).rejects.toThrow(/empty/);
    await expect(create({ size: MAX_UPLOAD_BYTES + 1 })).rejects.toThrow(
      /25 MB/,
    );
    await expect(create({ size: 1.5 })).rejects.toThrow(/empty/);
    await expect(create({ sha256: "xyz" })).rejects.toThrow(/SHA-256/);
    await expect(create({ name: " \n " })).rejects.toThrow(/name/);
    await expect(
      create({ notebookId: ada.notebookId } as Record<string, unknown>),
    ).rejects.toThrow(/exactly one/);
    await expect(create({ requestId: "short" })).rejects.toThrow(/request_id/);
    // Names lose control characters; long names keep their extension.
    const named = await create({ name: `  a\tb.pdf  ` });
    expect((await object(t, named.objectId))!.name).toBe("a b.pdf");
    const long = await create({ name: "x".repeat(400) + ".pdf" });
    const longName = (await object(t, long.objectId))!.name;
    expect(longName).toHaveLength(255);
    expect(longName.endsWith(".pdf")).toBe(true);
    // Media types lose parameters; unknown ones are binary.
    const typed = await create({ mimeType: "Text/Plain; charset=utf-8" });
    expect(typed.mimeType).toBe("text/plain");
    const odd = await create({ mimeType: "" });
    expect(odd.mimeType).toBe("application/octet-stream");
    // Trashed notes take no uploads.
    await ada.as.mutation(api.notes.trash, { noteId });
    await expect(create({})).rejects.toThrow(/Trash/);
  });

  test("a retried request returns the same object, never a second one", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Retry");
    const first = await ticket(ada.as, { noteId }, "bytes", {
      requestId: "request-1",
    });
    const again = await ticket(ada.as, { noteId }, "bytes", {
      requestId: "request-1",
    });
    expect(again.objectId).toBe(first.objectId);
    expect(again.replayed).toBe(true);
    expect(again.ticket).not.toBe(first.ticket);
    // Both tickets work.
    for (const each of [first.ticket!, again.ticket!])
      expect(
        (
          await service(t).query(api.files.uploadTarget, {
            objectId: first.objectId,
            ticket: each,
          })
        ).status,
      ).toBe("pending");
    await expect(
      ticket(ada.as, { noteId }, "other bytes", { requestId: "request-1" }),
    ).rejects.toThrow(/different upload/);
    await service(t).mutation(api.files.finalize, {
      objectId: first.objectId,
      ticket: first.ticket!,
      size: 5,
      sha256: await sha256("bytes"),
    });
    const done = await ticket(ada.as, { noteId }, "bytes", {
      requestId: "request-1",
    });
    expect(done).toMatchObject({
      objectId: first.objectId,
      state: "ready",
      ticket: null,
    });
    expect(
      await t.run((ctx) => ctx.db.query("objects").collect()),
    ).toHaveLength(1);
  });

  test("limit pending uploads per uploader", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Many");
    for (let i = 0; i < MAX_PENDING_UPLOADS; i++)
      await ticket(ada.as, { noteId }, `file ${i}`);
    await expect(ticket(ada.as, { noteId }, "one more")).rejects.toThrow(
      /Too many uploads/,
    );
    // Expired tickets no longer count.
    vi.advanceTimersByTime(TICKET_TTL_MS + 1);
    expect((await ticket(ada.as, { noteId }, "later")).state).toBe("pending");
  });
});

describe("the file service", () => {
  test("only the Worker's service identity may call it", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const claude = await agent(t, ada.id);
    const noteId = await createNote(ada.as, "Note");
    const granted = await ticket(ada.as, { noteId }, "abc");
    const args = { objectId: granted.objectId, ticket: granted.ticket! };
    const finalize = {
      ...args,
      size: 3,
      sha256: await sha256("abc"),
    };
    for (const caller of [
      t,
      ada.as,
      claude.as,
      t.withIdentity({
        issuer: "https://other.test",
        subject: "service:files",
      }),
      t.withIdentity({ issuer: AGENT_ISSUER, subject: "service:other" }),
    ]) {
      await expect(caller.query(api.files.uploadTarget, args)).rejects.toThrow(
        /file service/,
      );
      await expect(
        caller.mutation(api.files.finalize, finalize),
      ).rejects.toThrow(/file service/);
      await expect(
        caller.query(api.files.deletionBatch, { limit: 10 }),
      ).rejects.toThrow(/file service/);
      await expect(
        caller.mutation(api.files.confirmDeletions, { ids: [] }),
      ).rejects.toThrow(/file service/);
    }
    // The service identity is nobody: ordinary functions see no caller.
    await expect(
      service(t).query(api.notes.readMarkdown, { noteId, format: "markdown" }),
    ).rejects.toThrow(/Sign in/);
    expect(await service(t).query(api.notes.content, { noteId })).toBeNull();
  });

  test("checks tickets, and finalizing is idempotent", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const granted = await ticket(ada.as, { noteId }, "abc", {
      mimeType: "image/gif",
    });
    const svc = service(t);
    const target = (ticketValue: string, objectId: string = granted.objectId) =>
      svc.query(api.files.uploadTarget, { objectId, ticket: ticketValue });
    expect(await target(granted.ticket!)).toEqual({
      status: "pending",
      size: 3,
      sha256: await sha256("abc"),
      mimeType: "image/gif",
    });
    expect(await target("x".repeat(43))).toEqual({ status: "denied" });
    expect(await target(granted.ticket!, "not-an-id")).toEqual({
      status: "denied",
    });
    const finalize = (size: number, hash: string) =>
      svc.mutation(api.files.finalize, {
        objectId: granted.objectId,
        ticket: granted.ticket!,
        size,
        sha256: hash,
      });
    await expect(finalize(4, await sha256("abc"))).rejects.toThrow(
      /do not match/,
    );
    await expect(finalize(3, await sha256("abd"))).rejects.toThrow(
      /do not match/,
    );
    expect(
      await svc.mutation(api.files.finalize, {
        objectId: granted.objectId,
        ticket: "y".repeat(43),
        size: 3,
        sha256: await sha256("abc"),
      }),
    ).toEqual({ status: "denied" });
    expect(await finalize(3, await sha256("abc"))).toEqual({ status: "ready" });
    expect(await finalize(3, await sha256("abc"))).toEqual({ status: "ready" });
    expect((await target(granted.ticket!)).status).toBe("ready");
    const row = (await object(t, granted.objectId))!;
    expect(row.state).toBe("ready");
    // Uploaded but not in any note yet: unused from now.
    expect(row.trashedAt).toBe(Date.now());
    expect(
      await t.run((ctx) => ctx.db.query("objects").collect()),
    ).toHaveLength(1);
  });

  test("expired tickets: refused, then failed and cleaned up", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const late = await ticket(ada.as, { noteId }, "late");
    const never = await ticket(ada.as, { noteId }, "never");
    vi.advanceTimersByTime(TICKET_TTL_MS + 1);
    expect(
      await service(t).query(api.files.uploadTarget, {
        objectId: late.objectId,
        ticket: late.ticket!,
      }),
    ).toEqual({ status: "gone" });
    // An upload the Worker accepted just before expiry may still finish.
    expect(
      await service(t).mutation(api.files.finalize, {
        objectId: late.objectId,
        ticket: late.ticket!,
        size: 4,
        sha256: await sha256("late"),
      }),
    ).toEqual({ status: "ready" });
    vi.advanceTimersByTime(FINALIZE_GRACE_MS);
    expect(
      await service(t).mutation(api.files.finalize, {
        objectId: never.objectId,
        ticket: never.ticket!,
        size: 5,
        sha256: await sha256("never"),
      }),
    ).toEqual({ status: "gone" });
    expect((await object(t, never.objectId))!.state).toBe("failed");
    expect(await deletions(t)).toEqual([`objects/${never.objectId}`]);
    // The hourly sweep fails what is left and removes old failures.
    const third = await ticket(ada.as, { noteId }, "third");
    vi.advanceTimersByTime(TICKET_TTL_MS + FINALIZE_GRACE_MS + 1);
    await t.mutation(internal.files.expireUploads, {});
    expect((await object(t, third.objectId))!.state).toBe("failed");
    vi.advanceTimersByTime(DAY + 1);
    await t.mutation(internal.files.expireUploads, {});
    expect(await object(t, never.objectId)).toBeNull();
    expect(await object(t, third.objectId)).toBeNull();
    expect(await object(t, late.objectId)).not.toBeNull();
    expect(await deletions(t)).toEqual([
      `objects/${never.objectId}`,
      `objects/${third.objectId}`,
    ]);
  });

  test("drains the deletion queue", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const a = await ticket(ada.as, { noteId }, "a");
    await ada.as.mutation(api.files.cancelUpload, { objectId: a.objectId });
    const batch = await service(t).query(api.files.deletionBatch, {
      limit: 50,
    });
    expect(batch.map((row) => row.key)).toEqual([`objects/${a.objectId}`]);
    await service(t).mutation(api.files.confirmDeletions, {
      ids: batch.map((row) => row.id),
    });
    // Confirming twice is harmless.
    await service(t).mutation(api.files.confirmDeletions, {
      ids: batch.map((row) => row.id),
    });
    expect(await deletions(t)).toEqual([]);
  });

  test("cancelling an upload", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    const noteId = await createNote(ada.as, "Note");
    const pending = await ticket(ada.as, { noteId }, "p");
    await expect(
      ben.as.mutation(api.files.cancelUpload, { objectId: pending.objectId }),
    ).rejects.toThrow(/not found/);
    await ada.as.mutation(api.files.cancelUpload, {
      objectId: pending.objectId,
    });
    expect((await object(t, pending.objectId))!.state).toBe("failed");
    const unused = await upload(t, ada.as, { noteId }, "unused");
    await ada.as.mutation(api.files.cancelUpload, { objectId: unused });
    expect(await object(t, unused)).toBeNull();
    const used = await upload(t, ada.as, { noteId }, "used");
    await replaceAll(ada.as, noteId, `Note\n\n${image(used)}`);
    await expect(
      ada.as.mutation(api.files.cancelUpload, { objectId: used }),
    ).rejects.toThrow(/remove it from the note/);
  });
});

describe("references", () => {
  test("every accepted revision records the objects it references", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Album");
    const photo = await upload(t, ada.as, { noteId });
    expect((await object(t, photo))!.trashedAt).toBeDefined();

    await replaceAll(ada.as, noteId, `Album\n\n${image(photo)}`);
    let rows = await refs(t, photo);
    expect(rows).toMatchObject([{ noteId, current: true, live: true }]);
    expect((await object(t, photo))!.trashedAt).toBeUndefined();

    // Ordinary edits elsewhere change nothing.
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    await ada.as.mutation(api.notes.edit, {
      noteId,
      expectedRevision: content.revision,
      edits: [{ type: "append", markdown: "More text." }],
    });
    expect(await refs(t, photo)).toEqual(rows);

    // Removing the last reference puts it in Trash.
    vi.advanceTimersByTime(1000);
    await replaceAll(ada.as, noteId, "Album");
    rows = await refs(t, photo);
    expect(rows).toMatchObject([{ current: false, live: false }]);
    const trashedAt = (await object(t, photo))!.trashedAt;
    expect(trashedAt).toBe(Date.now());

    // Undo brings it back; a second removal starts a fresh Trash period.
    await replaceAll(ada.as, noteId, `Album\n\n${image(photo)}`);
    expect((await object(t, photo))!.trashedAt).toBeUndefined();
    expect(await refs(t, photo)).toHaveLength(1);
  });

  test("an object stays active while any active note uses it", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const first = await createNote(ada.as, "One");
    const photo = await upload(t, ada.as, { noteId: first });
    await replaceAll(ada.as, first, `One\n\n${image(photo)}`);
    const second = await createNote(ada.as, `Two\n\n${image(photo)}`);
    expect(await refs(t, photo)).toHaveLength(2);
    await replaceAll(ada.as, first, "One");
    expect((await object(t, photo))!.trashedAt).toBeUndefined();
    // Trashing the other note trashes it (D42) ...
    await ada.as.mutation(api.notes.trash, { noteId: second });
    await settle(t);
    expect((await object(t, photo))!.trashedAt).toBeDefined();
    // ... and restoring the note brings it back.
    await ada.as.mutation(api.notes.restore, { noteId: second });
    await settle(t);
    expect((await object(t, photo))!.trashedAt).toBeUndefined();
  });

  test("trashing a note keeps objects another active note uses", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const a = await createNote(ada.as, "A");
    const photo = await upload(t, ada.as, { noteId: a });
    await replaceAll(ada.as, a, `A\n\n${image(photo)}`);
    await createNote(ada.as, `B\n\n${image(photo)}`);
    await ada.as.mutation(api.notes.trash, { noteId: a });
    await settle(t);
    expect((await object(t, photo))!.trashedAt).toBeUndefined();
  });

  test("a reference grants nothing unless the actor may already use the object", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    const secret = await createNote(ada.as, "Private");
    const photo = await upload(t, ada.as, { noteId: secret });
    await replaceAll(ada.as, secret, `Private\n\n${image(photo)}`);

    // Ben learns the ID and puts it in his own note: accepted, not recorded.
    const mine = await createNote(ben.as, `Mine\n\n${image(photo)}`);
    expect((await refs(t, photo)).map((r) => r.noteId)).toEqual([secret]);
    expect(
      await ben.as.query(api.files.authorizeRead, {
        noteId: mine,
        objectId: photo,
      }),
    ).toEqual({ access: "denied" });
    expect(await ben.as.query(api.files.noteObjects, { noteId: mine })).toEqual(
      [],
    );
    // Editing his note later does not record it either.
    await replaceAll(ben.as, mine, `Mine!\n\n${image(photo)}`);
    expect(await refs(t, photo)).toHaveLength(1);
    // Ada trashing her note still trashes the object: Ben's copy is no use.
    await ada.as.mutation(api.notes.trash, { noteId: secret });
    await settle(t);
    expect((await object(t, photo))!.trashedAt).toBeDefined();
  });

  test("copying an attachment the actor can read records it", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    await share(t, ada.notebookId, ben.id, "read", ada.id);
    const shared = await createNote(ada.as, "Shared");
    const photo = await upload(t, ada.as, { noteId: shared });
    await replaceAll(ada.as, shared, `Shared\n\n${image(photo)}`);
    const copy = await createNote(ben.as, `Copy\n\n${image(photo)}`);
    expect(
      await ben.as.query(api.files.authorizeRead, {
        noteId: copy,
        objectId: photo,
      }),
    ).toMatchObject({ access: "granted" });
    // Cross-owner (Q11): Ben's active note keeps Ada's object active.
    await ada.as.mutation(api.notes.trash, { noteId: shared });
    await settle(t);
    expect((await object(t, photo))!.trashedAt).toBeUndefined();
  });

  test("references to deleted objects are accepted and show as deleted", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const gone = await upload(t, ada.as, { noteId }, "gone");
    await ada.as.mutation(api.files.cancelUpload, { objectId: gone });
    await replaceAll(ada.as, noteId, `Note\n\n${image(gone)}`);
    expect(await ada.as.query(api.files.noteObjects, { noteId })).toEqual([]);
    expect(await refs(t, gone)).toEqual([]);
  });

  test("agents attach their uploads with Markdown", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const claude = await agent(t, ada.id);
    await share(t, ada.notebookId, claude.id, "edit", ada.id);
    const noteId = await createNote(ada.as, "Report");
    const pdf = await upload(t, claude.as, { noteId }, "%PDF-1.7");
    await claude.as.mutation(api.notes.edit, {
      noteId,
      edits: [
        {
          type: "append",
          markdown: `[q3.pdf](attachment:${pdf}){type=application/pdf size=8}`,
        },
      ],
    });
    expect(await refs(t, pdf)).toMatchObject([{ noteId, current: true }]);
    expect(await ada.as.query(api.files.noteObjects, { noteId })).toMatchObject(
      [{ objectId: pdf, name: "photo.png", state: "ready", trashed: false }],
    );
    const read = await claude.as.query(api.notes.readMarkdown, {
      noteId,
      format: "markdown",
    });
    expect(read.markdown).toContain(
      `[q3.pdf](attachment:${pdf}){type=application/pdf size=8}`,
    );
  });

  test("a note can hold at most MAX_NOTE_OBJECTS attachments", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Many");
    const ids = await t.run(async (ctx) => {
      const made: string[] = [];
      for (let i = 0; i <= MAX_NOTE_OBJECTS; i++)
        made.push(
          await ctx.db.insert("objects", {
            ownerId: ada.id,
            uploaderId: ada.id,
            name: `${i}.png`,
            mimeType: "image/png",
            size: 1,
            sha256: "0".repeat(64),
            state: "ready",
            ticketHashes: [],
            createdAt: Date.now(),
            trashedAt: Date.now(),
          }),
        );
      return made;
    });
    await expect(
      replaceAll(ada.as, noteId, ids.map((id) => image(id)).join("\n\n")),
    ).rejects.toThrow(/at most 200 attachments/);
    await replaceAll(
      ada.as,
      noteId,
      ids
        .slice(0, MAX_NOTE_OBJECTS)
        .map((id) => image(id))
        .join("\n\n"),
    );
    expect(
      (await ada.as.query(api.files.noteObjects, { noteId }))!.length,
    ).toBe(MAX_NOTE_OBJECTS);
  });
});

describe("restoring and purging", () => {
  test("restoring a revision revives a trashed object", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const photo = await upload(t, ada.as, { noteId });
    await replaceAll(ada.as, noteId, `Note\n\n${image(photo)}`);
    const withPhoto = (await ada.as.query(api.notes.content, { noteId }))!
      .revision;
    await replaceAll(ada.as, noteId, "Note");
    expect((await object(t, photo))!.trashedAt).toBeDefined();
    const current = (await ada.as.query(api.notes.content, { noteId }))!
      .revision;
    await ada.as.mutation(api.history.restore, {
      noteId,
      revision: withPhoto,
      expectedRevision: current,
    });
    expect((await object(t, photo))!.trashedAt).toBeUndefined();
    expect(await refs(t, photo)).toMatchObject([{ current: true, live: true }]);
  });

  test("Trash retention purges unused objects and queues their bytes", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const photo = await upload(t, ada.as, { noteId });
    await replaceAll(ada.as, noteId, `Note\n\n${image(photo)}`);
    const withPhoto = (await ada.as.query(api.notes.content, { noteId }))!
      .revision;
    await replaceAll(ada.as, noteId, "Note");
    vi.advanceTimersByTime(29 * DAY);
    await t.mutation(internal.files.purgeExpired, {});
    expect(await object(t, photo)).not.toBeNull();
    vi.advanceTimersByTime(DAY + 1);
    await t.mutation(internal.files.purgeExpired, {});
    await settle(t);
    expect(await object(t, photo)).toBeNull();
    expect(await refs(t, photo)).toEqual([]);
    expect(await deletions(t)).toEqual([`objects/${photo}`]);
    // Restoring the old revision keeps the reference's place; it reads as
    // permanently deleted (D40).
    const current = (await ada.as.query(api.notes.content, { noteId }))!
      .revision;
    await ada.as.mutation(api.history.restore, {
      noteId,
      revision: withPhoto,
      expectedRevision: current,
    });
    const read = await ada.as.query(api.notes.readMarkdown, {
      noteId,
      format: "markdown",
    });
    expect(read.markdown).toContain(`attachment:${photo}`);
    expect(await ada.as.query(api.files.noteObjects, { noteId })).toEqual([]);
    expect(
      await ada.as.query(api.files.authorizeRead, { noteId, objectId: photo }),
    ).toEqual({ access: "denied" });
  });

  test("retention follows the object owner's setting; manual keeps it", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    await ada.as.mutation(api.lifecycle.setTrashRetention, { days: 0 });
    const noteId = await createNote(ada.as, "Note");
    const photo = await upload(t, ada.as, { noteId });
    await replaceAll(ada.as, noteId, `Note\n\n${image(photo)}`);
    await replaceAll(ada.as, noteId, "Note");
    vi.advanceTimersByTime(300 * DAY);
    await t.mutation(internal.files.purgeExpired, {});
    expect(await object(t, photo)).not.toBeNull();
    await ada.as.mutation(api.lifecycle.setTrashRetention, { days: 1 });
    await t.mutation(internal.files.purgeExpired, {});
    expect(await object(t, photo)).toBeNull();
  });

  test("objects no note ever used are removed after a week", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    await ada.as.mutation(api.lifecycle.setTrashRetention, { days: 0 });
    const noteId = await createNote(ada.as, "Note");
    const orphan = await upload(t, ada.as, { noteId });
    vi.advanceTimersByTime(ORPHAN_TTL_MS - DAY);
    await t.mutation(internal.files.purgeExpired, {});
    expect(await object(t, orphan)).not.toBeNull();
    vi.advanceTimersByTime(DAY);
    await t.mutation(internal.files.purgeExpired, {});
    expect(await object(t, orphan)).toBeNull();
    expect(await deletions(t)).toEqual([`objects/${orphan}`]);
  });

  test("a note in Trash that still contains an object keeps it (Q11)", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    await share(t, ada.notebookId, ben.id, "read", ada.id);
    // Ben keeps Trash forever; Ada one day.
    await ben.as.mutation(api.lifecycle.setTrashRetention, { days: 0 });
    await ada.as.mutation(api.lifecycle.setTrashRetention, { days: 1 });
    const source = await createNote(ada.as, "Source");
    const photo = await upload(t, ada.as, { noteId: source });
    await replaceAll(ada.as, source, `Source\n\n${image(photo)}`);
    const copy = await createNote(ben.as, `Copy\n\n${image(photo)}`);
    await ben.as.mutation(api.notes.trash, { noteId: copy });
    await replaceAll(ada.as, source, "Source");
    await settle(t);
    expect((await object(t, photo))!.trashedAt).toBeDefined();
    vi.advanceTimersByTime(5 * DAY);
    await t.mutation(internal.files.purgeExpired, {});
    expect(await object(t, photo)).not.toBeNull();
    // Restoring Ben's note brings it back into use.
    await ben.as.mutation(api.notes.restore, { noteId: copy });
    await settle(t);
    expect((await object(t, photo))!.trashedAt).toBeUndefined();
  });

  test("deleting a note forever deletes objects only it ever used", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const doomed = await createNote(ada.as, "Doomed");
    const only = await upload(t, ada.as, { noteId: doomed }, "only");
    const shared = await upload(t, ada.as, { noteId: doomed }, "shared");
    const once = await upload(t, ada.as, { noteId: doomed }, "once");
    await replaceAll(
      ada.as,
      doomed,
      `Doomed\n\n${image(only)}\n\n${image(shared)}`,
    );
    const other = await createNote(
      ada.as,
      `Other\n\n${image(shared)}\n\n${image(once)}`,
    );
    // `once` is only in the other note's history.
    await replaceAll(ada.as, other, `Other\n\n${image(shared)}`);
    await ada.as.mutation(api.notes.trash, { noteId: doomed });
    await settle(t);
    expect((await object(t, only))!.trashedAt).toBeDefined();
    await ada.as.mutation(api.lifecycle.deleteForever, { noteId: doomed });
    await settle(t);
    expect(await object(t, only)).toBeNull();
    expect(await object(t, shared)).not.toBeNull();
    expect((await object(t, shared))!.trashedAt).toBeUndefined();
    expect(await object(t, once)).not.toBeNull();
    expect(await deletions(t)).toEqual([`objects/${only}`]);
    expect((await refs(t, shared)).map((r) => r.noteId)).toEqual([other]);
  });
});

describe("reading bytes", () => {
  test("needs read access to a note that references the object", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    const cy = await human(t, "Cy");
    const dee = await human(t, "Dee");
    const claude = await agent(t, ada.id);
    await share(t, ada.notebookId, ben.id, "edit", ada.id);
    await share(t, ada.notebookId, cy.id, "read", ada.id);
    const noteId = await createNote(ada.as, "Note");
    const photo = await upload(t, ada.as, { noteId });
    const unused = await upload(t, ada.as, { noteId }, "unused");
    await replaceAll(ada.as, noteId, `Note\n\n${image(photo)}`);
    const read = (as: As, objectId: string = photo, note: string = noteId) =>
      as.query(api.files.authorizeRead, { noteId: note, objectId });
    const granted = {
      access: "granted",
      name: "photo.png",
      mimeType: "image/png",
      size: 9,
      sha256: await sha256("png bytes"),
    };
    expect(await read(ada.as)).toEqual(granted);
    expect(await read(ben.as)).toEqual(granted);
    expect(await read(cy.as)).toEqual(granted);
    expect(await read(dee.as)).toEqual({ access: "denied" });
    expect(await read(claude.as)).toEqual({ access: "denied" });
    await share(t, ada.notebookId, claude.id, "read", ada.id);
    expect(await read(claude.as)).toEqual(granted);
    expect(
      await t.query(api.files.authorizeRead, {
        noteId,
        objectId: photo,
      }),
    ).toEqual({ access: "unauthenticated" });
    // Not referenced by the note, or not a real ID.
    expect(await read(ada.as, unused)).toEqual({ access: "denied" });
    expect(await read(ada.as, "nope")).toEqual({ access: "denied" });
    expect(await read(ada.as, photo, "nope")).toEqual({ access: "denied" });
    // A note override hides it again.
    await t.run((ctx) =>
      ctx.db.insert("noteMembers", {
        noteId,
        principalId: cy.id,
        role: "none",
        grantedBy: ada.id,
        createdAt: Date.now(),
      }),
    );
    expect(await read(cy.as)).toEqual({ access: "denied" });
    // Trashed notes stay readable, with their objects.
    await ada.as.mutation(api.notes.trash, { noteId });
    await settle(t);
    expect(await read(ben.as)).toEqual(granted);
  });

  test("history: editors may read objects earlier revisions referenced", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    const cy = await human(t, "Cy");
    await share(t, ada.notebookId, ben.id, "edit", ada.id);
    await share(t, ada.notebookId, cy.id, "read", ada.id);
    const noteId = await createNote(ada.as, "Note");
    const photo = await upload(t, ada.as, { noteId });
    await replaceAll(ada.as, noteId, `Note\n\n${image(photo)}`);
    await replaceAll(ada.as, noteId, "Note");
    const read = (as: As) =>
      as.query(api.files.authorizeRead, { noteId, objectId: photo });
    expect((await read(ben.as)).access).toBe("granted");
    expect((await read(cy.as)).access).toBe("denied");
  });

  test("pending uploads are not readable", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const pending = await ticket(ada.as, { noteId });
    await replaceAll(ada.as, noteId, `Note\n\n${image(pending.objectId)}`);
    expect(await refs(t, pending.objectId)).toHaveLength(1);
    expect(
      await ada.as.query(api.files.authorizeRead, {
        noteId,
        objectId: pending.objectId,
      }),
    ).toEqual({ access: "denied" });
    expect(await ada.as.query(api.files.noteObjects, { noteId })).toMatchObject(
      [{ state: "pending" }],
    );
  });

  test("public links serve only objects in the published content", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Public");
    const shown = await upload(t, ada.as, { noteId }, "shown");
    const removed = await upload(t, ada.as, { noteId }, "removed");
    const elsewhere = await upload(t, ada.as, { noteId }, "elsewhere");
    await createNote(ada.as, `Private\n\n${image(elsewhere)}`);
    await replaceAll(ada.as, noteId, `Public\n\n${image(removed)}`);
    await replaceAll(ada.as, noteId, `Public\n\n${image(shown)}`);
    const { token } = await ada.as.mutation(api.publishing.publish, {
      noteId,
    });
    const read = (objectId: string, link = token) =>
      t.query(api.files.authorizePublicRead, { token: link, objectId });
    expect(await read(shown)).toMatchObject({ name: "photo.png", size: 5 });
    expect(await read(removed)).toBeNull();
    expect(await read(elsewhere)).toBeNull();
    expect(await read(shown, "x".repeat(43))).toBeNull();
    expect(await read(shown, "short")).toBeNull();
    // Unavailable while the note is in Trash (D38), back after restore.
    await ada.as.mutation(api.notes.trash, { noteId });
    expect(await read(shown)).toBeNull();
    await ada.as.mutation(api.notes.restore, { noteId });
    expect(await read(shown)).not.toBeNull();
    // A replaced link stops working; the new one works.
    const { token: next } = await ada.as.mutation(api.publishing.replace, {
      noteId,
    });
    expect(await read(shown)).toBeNull();
    expect(await read(shown, next)).not.toBeNull();
    await ada.as.mutation(api.publishing.unpublish, { noteId });
    expect(await read(shown, next)).toBeNull();
  });
});
