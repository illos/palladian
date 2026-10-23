/// <reference types="vite/client" />
// Regression tests for review round 2 of B1+B2
// (docs/reviews/notes-files-backend-round2-astra-review.md).
import { notesSchema } from "@palladian/notes-core";
import { Transform } from "prosemirror-transform";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { UPLOAD_LEASE_MS } from "../convex/files";
import { MAX_NOTE_OBJECTS } from "../convex/references";
import {
  agent,
  createNote,
  DAY,
  docJson,
  human,
  image,
  object,
  refs,
  service,
  settle,
  setup,
  share,
  ticket,
  upload,
  type T,
} from "./files-harness";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Ready objects owned by `owner`, each referenced by `notes` in order. */
async function referenced(
  t: T,
  owner: Id<"principals">,
  count: number,
  notes: Id<"notes">[],
) {
  return await t.run(async (ctx) => {
    const ids: Id<"objects">[] = [];
    for (let i = 0; i < count; i++) {
      const objectId = await ctx.db.insert("objects", {
        ownerId: owner,
        uploaderId: owner,
        name: `${i}.png`,
        mimeType: "image/png",
        size: 1,
        sha256: "0".repeat(64),
        state: "ready",
        ticketHashes: [],
        createdAt: Date.now(),
      });
      for (const noteId of notes)
        await ctx.db.insert("objectRefs", {
          noteId,
          objectId,
          current: true,
          live: true,
        });
      ids.push(objectId);
    }
    return ids;
  });
}

async function hiddenNotes(
  as: Awaited<ReturnType<typeof human>>["as"],
  count: number,
) {
  const book = await as.mutation(api.notebooks.create, { name: "Private" });
  const notes: Id<"notes">[] = [];
  for (let i = 0; i < count; i++)
    notes.push(
      (
        await as.mutation(api.notes.create, {
          clientKey: `hidden-${i}-${Math.random()}`,
          notebookId: book,
          doc: docJson(`Hidden ${i}`),
        })
      ).noteId,
    );
  return { book, notes };
}

async function pushImage(
  as: Awaited<ReturnType<typeof human>>["as"],
  noteId: Id<"notes">,
  objectId: string,
  sourceNoteIds?: Id<"notes">[],
) {
  const content = (await as.query(api.notes.content, { noteId }))!;
  const doc = notesSchema.nodeFromJSON(JSON.parse(content.doc));
  const tr = new Transform(doc).insert(
    doc.content.size,
    notesSchema.nodes.image!.create({ src: `attachment:${objectId}` }),
  );
  return await as.mutation(api.notes.push, {
    noteId,
    revision: content.revision,
    steps: tr.steps.map((s) => JSON.stringify(s.toJSON())),
    clientId: "c1",
    ...(sourceNoteIds ? { sourceNoteIds } : {}),
  });
}

const read = (
  as: Awaited<ReturnType<typeof human>>["as"],
  noteId: Id<"notes">,
  objectId: Id<"objects">,
) =>
  as.query(api.files.authorizeRead, { noteId, objectId }).then((r) => r.access);

describe("R2-1/R2-3: authorization is decided once, at acceptance", () => {
  test("an unproven reference never grants, whatever happens later", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const claude = await agent(t, ada.id);
    const { book: agentBook } = await hiddenNotes(ada.as, 0);
    await share(t, agentBook, claude.id, "edit", ada.id);
    const destination = (
      await ada.as.mutation(api.notes.create, {
        clientKey: "dest",
        notebookId: agentBook,
        doc: docJson("Destination"),
      })
    ).noteId;
    // Nine notes the agent cannot read come first, then one it will later.
    const { notes: hidden } = await hiddenNotes(ada.as, 9);
    const { book: laterBook, notes: later } = await hiddenNotes(ada.as, 1);
    const [photo] = await referenced(t, ada.id, 1, [...hidden, ...later]);
    await pushImage(claude.as, destination, photo!);
    expect((await refs(t, photo!)).some((r) => r.noteId === destination)).toBe(
      false,
    );
    // Before anything scheduled runs: the agent's connection and its
    // destination grant end, then it gains read access to the source.
    await t.run(async (ctx) => {
      const connection = await ctx.db
        .query("connections")
        .withIndex("by_agent", (q) => q.eq("agentId", claude.id))
        .first();
      await ctx.db.patch(connection!._id, { revokedAt: Date.now() });
      const grant = await ctx.db
        .query("notebookMembers")
        .withIndex("by_notebook_and_principal", (q) =>
          q.eq("notebookId", agentBook).eq("principalId", claude.id),
        )
        .unique();
      await ctx.db.delete(grant!._id);
    });
    await share(t, laterBook, claude.id, "read", ada.id);
    await settle(t);
    vi.advanceTimersByTime(DAY);
    await settle(t);
    expect((await refs(t, photo!)).some((r) => r.noteId === destination)).toBe(
      false,
    );
    // A revoked connection cannot commit at all.
    const current = (await ada.as.query(api.notes.content, {
      noteId: destination,
    }))!;
    await expect(
      claude.as.mutation(api.notes.push, {
        noteId: destination,
        revision: current.revision,
        steps: [],
        clientId: "c1",
      }),
    ).rejects.toThrow(/Sign in/);
    // Nor does a person later able to read the source upgrade an old reference.
    const ben = await human(t, "Ben");
    const bens = await createNote(ben.as, `Ben\n\n${image(photo!)}`);
    await share(t, laterBook, ben.id, "read", ada.id);
    await settle(t);
    await createNote(ben.as, "unrelated edit");
    expect(await read(ben.as, bens, photo!)).toBe("denied");
  });

  test("a proven copy keeps its grant after the source is revoked or deleted", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    await share(t, ada.notebookId, ben.id, "read", ada.id);
    const source = await createNote(ada.as, "Source");
    const { notes: hidden } = await hiddenNotes(ada.as, 9);
    const [photo] = await referenced(t, ada.id, 1, [...hidden, source]);
    const copy = (
      await ben.as.mutation(api.notes.create, {
        clientKey: "copy",
        doc: docJson(`Copy\n\n${image(photo!)}`),
        sourceNoteId: source,
      })
    ).noteId;
    const row = (await refs(t, photo!)).find((r) => r.noteId === copy)!;
    expect(row).toMatchObject({
      current: true,
      live: true,
      proof: "source",
      proofNoteId: source,
    });
    // Revoked between acceptance and any later step: the grant stays.
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query("notebookMembers")
        .withIndex("by_notebook_and_principal", (q) =>
          q.eq("notebookId", ada.notebookId).eq("principalId", ben.id),
        )
        .unique();
      await ctx.db.delete(member!._id);
    });
    await settle(t);
    expect(await read(ben.as, copy, photo!)).toBe("granted");
    // Every note Ada had goes; Ben's copy keeps the object alive.
    for (const noteId of [source, ...hidden]) {
      await ada.as.mutation(api.notes.trash, { noteId });
      await ada.as.mutation(api.lifecycle.deleteForever, { noteId });
    }
    await settle(t);
    expect(await object(t, photo!)).not.toBeNull();
    expect((await object(t, photo!))!.trashedAt).toBeUndefined();
    expect(await read(ben.as, copy, photo!)).toBe("granted");
  });

  test("proofs: uploader, the bounded search, and this note's own history", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    await share(t, ada.notebookId, ben.id, "read", ada.id);
    const noteId = await createNote(ada.as, "Note");
    const photo = await upload(t, ada.as, { noteId });
    await pushImage(ada.as, noteId, photo);
    expect((await refs(t, photo))[0]).toMatchObject({ proof: "uploader" });
    const copy = await createNote(ben.as, `Copy\n\n${image(photo)}`);
    expect((await refs(t, photo)).find((r) => r.noteId === copy)).toMatchObject(
      { proof: "search", proofNoteId: noteId },
    );
  });

  test("no deferred verification exists", async () => {
    const files = await import("../convex/files");
    expect("verifyReference" in files).toBe(false);
    const schema = (await import("../convex/schema")).default;
    expect("referenceChecks" in schema.tables).toBe(false);
  });
});

describe("R2-2: deletion tombstones outlive late writes", () => {
  async function cancelledDuringLease(t: T) {
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const granted = await ticket(ada.as, { noteId }, "bytes");
    const admission = await service(t).mutation(api.files.admitUpload, {
      objectId: granted.objectId,
      ticket: granted.ticket!,
    });
    await ada.as.mutation(api.files.cancelUpload, {
      objectId: granted.objectId,
    });
    return {
      ada,
      noteId,
      granted,
      leaseUntil: (admission as { leaseUntil: number }).leaseUntil,
    };
  }
  const sweep = async (t: T) => {
    const batch = await service(t).mutation(api.files.deletionBatch, {
      limit: 100,
    });
    await service(t).mutation(api.files.confirmDeletions, {
      ids: batch.map((row) => row.id),
    });
    return batch.map((row) => row.key);
  };
  const tombstones = (t: T) =>
    t.run((ctx) => ctx.db.query("objectDeletions").collect());

  test("a leased upload's key is re-deleted daily until seven days after the lease", async () => {
    const t = setup();
    const { granted, leaseUntil } = await cancelledDuringLease(t);
    const key = `objects/${granted.objectId}`;
    // The first pass is due at once.
    expect(await sweep(t)).toEqual([key]);
    expect(await tombstones(t)).toMatchObject([{ key, passes: 1 }]);
    // Not again in the same run.
    expect(await sweep(t)).toEqual([]);
    // Every daily run deletes it again (a write may have landed since) ...
    let passes = 1;
    while (Date.now() < leaseUntil + 7 * DAY) {
      vi.advanceTimersByTime(DAY);
      expect(await sweep(t)).toEqual([key]);
      passes++;
    }
    // ... and the tombstone retires only after seven days past the lease.
    expect(passes).toBeGreaterThanOrEqual(8);
    expect(await tombstones(t)).toEqual([]);
  });

  test("an upload never admitted needs one pass", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const granted = await ticket(ada.as, { noteId }, "bytes");
    await ada.as.mutation(api.files.cancelUpload, {
      objectId: granted.objectId,
    });
    expect(await sweep(t)).toEqual([`objects/${granted.objectId}`]);
    expect(await tombstones(t)).toEqual([]);
  });

  test("an expired upload's tombstone also waits seven days after its lease", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const granted = await ticket(ada.as, { noteId }, "bytes");
    const admission = await service(t).mutation(api.files.admitUpload, {
      objectId: granted.objectId,
      ticket: granted.ticket!,
    });
    vi.advanceTimersByTime(2 * 60 * 60_000);
    await t.mutation(internal.files.expireUploads, {});
    expect((await object(t, granted.objectId))!.state).toBe("failed");
    expect(await sweep(t)).toEqual([`objects/${granted.objectId}`]);
    vi.advanceTimersByTime(2 * DAY);
    // The failed record goes; the tombstone stays.
    await t.mutation(internal.files.expireUploads, {});
    expect(await object(t, granted.objectId)).toBeNull();
    expect(await tombstones(t)).toHaveLength(1);
    expect((await tombstones(t))[0]!.retainUntil).toBe(
      (admission as { leaseUntil: number }).leaseUntil + 7 * DAY,
    );
    expect(UPLOAD_LEASE_MS).toBe(15 * 60_000);
  });
});

describe("R2-4: legacy revisions restore", () => {
  test("history.restore brings back a stored legacy revision, granting nothing", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Legacy");
    const legacy = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [{ type: "text", text: "Legacy" }],
        },
        {
          type: "image",
          attrs: { id: "i1", src: " Attachment:Some/Old-ID ", alt: "old" },
        },
      ],
    };
    await t.run(async (ctx) => {
      const content = await ctx.db
        .query("noteContent")
        .withIndex("by_note", (q) => q.eq("noteId", noteId))
        .unique();
      await ctx.db.patch(content!._id, { doc: JSON.stringify(legacy) });
      const checkpoint = await ctx.db
        .query("noteCheckpoints")
        .withIndex("by_note_and_revision", (q) =>
          q.eq("noteId", noteId).eq("revision", 0),
        )
        .unique();
      await ctx.db.patch(checkpoint!._id, { doc: JSON.stringify(legacy) });
    });
    // Remove the legacy image, then restore the revision that had it.
    const before = (await ada.as.query(api.notes.content, { noteId }))!;
    const removed = await ada.as.mutation(api.notes.edit, {
      noteId,
      expectedRevision: before.revision,
      edits: [{ type: "replace_all", markdown: "Legacy, cleaned" }],
    });
    const restored = await ada.as.mutation(api.history.restore, {
      noteId,
      revision: 0,
      expectedRevision: removed.revision,
    });
    expect(restored.revision).toBeGreaterThan(removed.revision);
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    expect(content.doc).toContain("Attachment:Some/Old-ID");
    expect(await ada.as.query(api.files.noteObjects, { noteId })).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("objectRefs").collect())).toEqual(
      [],
    );
    // Clients still cannot submit such a source.
    const content2 = (await ada.as.query(api.notes.content, { noteId }))!;
    const doc = notesSchema.nodeFromJSON(JSON.parse(content2.doc));
    const tr = new Transform(doc).insert(
      doc.content.size,
      notesSchema.nodes.image!.create({ src: "Attachment:Another/Old" }),
    );
    await expect(
      ada.as.mutation(api.notes.push, {
        noteId,
        revision: content2.revision,
        steps: tr.steps.map((s) => JSON.stringify(s.toJSON())),
        clientId: "c1",
      }),
    ).rejects.toThrow(/invalid or unsafe/);
  });
});

describe("R2-5: every accepted revision stays within the attachment limit", () => {
  test("200 → 400 → 200 in one push is refused", async () => {
    const t = setup({ databaseQueries: 2000 });
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Many");
    const first = await referenced(t, ada.id, MAX_NOTE_OBJECTS, []);
    const second = await referenced(t, ada.id, MAX_NOTE_OBJECTS, []);
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    await ada.as.mutation(api.notes.edit, {
      noteId,
      expectedRevision: content.revision,
      edits: [
        {
          type: "replace_all",
          markdown: ["Many", ...first.map((id) => image(id))].join("\n\n"),
        },
      ],
    });
    const now = (await ada.as.query(api.notes.content, { noteId }))!;
    const doc = notesSchema.nodeFromJSON(JSON.parse(now.doc));
    const tr = new Transform(doc);
    const end = doc.content.size;
    tr.insert(
      end,
      second.map((id) =>
        notesSchema.nodes.image!.create({ src: `attachment:${id}` }),
      ),
    );
    // Then remove the original 200 (everything after the title).
    tr.delete(doc.child(0).nodeSize, end);
    expect(tr.steps).toHaveLength(2);
    await expect(
      ada.as.mutation(api.notes.push, {
        noteId,
        revision: now.revision,
        steps: tr.steps.map((s) => JSON.stringify(s.toJSON())),
        clientId: "c1",
      }),
    ).rejects.toThrow(/at most 200 attachments/);
    // In the other order every revision stays within the limit.
    const swap = new Transform(doc);
    swap.delete(doc.child(0).nodeSize, end);
    swap.insert(
      swap.doc.content.size,
      second.map((id) =>
        notesSchema.nodes.image!.create({ src: `attachment:${id}` }),
      ),
    );
    const accepted = await ada.as.mutation(api.notes.push, {
      noteId,
      revision: now.revision,
      steps: swap.steps.map((s) => JSON.stringify(s.toJSON())),
      clientId: "c1",
    });
    expect(accepted.status).toBe("accepted");
  }, 120_000);
});
