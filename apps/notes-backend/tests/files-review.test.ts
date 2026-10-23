/// <reference types="vite/client" />
// Regression tests for review round 1 of B1+B2
// (docs/reviews/notes-files-backend-round1-astra-review.md).
import { notesSchema } from "@palladian/notes-core";
import { Transform } from "prosemirror-transform";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { UPLOAD_LEASE_MS, WRITE_SETTLE_MS } from "../convex/files";
import { MAX_NOTE_OBJECTS } from "../convex/references";
import {
  createNote,
  DAY,
  deletions,
  docJson,
  human,
  image,
  object,
  refs,
  service,
  settle,
  setup,
  sha256,
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

/**
 * `count` ready objects owned and uploaded by `owner`, each referenced first
 * by `hidden` notes the reader cannot open and then by `visible`.
 */
async function referencedObjects(
  t: T,
  owner: Id<"principals">,
  count: number,
  hidden: Id<"notes">[],
  visible: Id<"notes">,
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
      for (const noteId of [...hidden, visible])
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

/** Ada's notes: `hidden` in a notebook only she sees, one shared with Ben to read. */
async function sharedFixture(t: T, hiddenCount: number) {
  const ada = await human(t, "Ada");
  const ben = await human(t, "Ben");
  const privateBook = await ada.as.mutation(api.notebooks.create, {
    name: "Private",
  });
  const hidden: Id<"notes">[] = [];
  for (let i = 0; i < hiddenCount; i++)
    hidden.push(
      (
        await ada.as.mutation(api.notes.create, {
          clientKey: `hidden-${i}`,
          notebookId: privateBook,
          doc: docJson(`Hidden ${i}`),
        })
      ).noteId,
    );
  await share(t, ada.notebookId, ben.id, "read", ada.id);
  const visible = await createNote(ada.as, "Shared with Ben");
  return { ada, ben, hidden, visible };
}

async function pendingChecks(t: T) {
  return await t.run((ctx) => ctx.db.query("referenceChecks").collect());
}

describe("F1/F4: authorizing copied attachments stays complete and within limits", () => {
  test("200 attachments readable only through their eighth reference", async () => {
    const t = setup(true);
    const { ada, ben, hidden, visible } = await sharedFixture(t, 7);
    const ids = await referencedObjects(
      t,
      ada.id,
      MAX_NOTE_OBJECTS,
      hidden,
      visible,
    );
    const markdown = ["Copy", ...ids.map((id) => image(id))].join("\n\n");
    const { noteId } = await ben.as.mutation(api.notes.create, {
      clientKey: "copy",
      doc: docJson(markdown),
    });
    // Whatever was not settled in the transaction is verified afterwards.
    await settle(t);
    expect(await pendingChecks(t)).toEqual([]);
    const granted = await ben.as.query(api.files.noteObjects, { noteId });
    expect(granted!.length).toBe(MAX_NOTE_OBJECTS);
    expect(
      (
        await ben.as.query(api.files.authorizeRead, {
          noteId,
          objectId: ids.at(-1)!,
        })
      ).access,
    ).toBe("granted");
  }, 60_000);

  test("a named source note proves access in the same transaction", async () => {
    const t = setup(true);
    const { ada, ben, hidden, visible } = await sharedFixture(t, 9);
    const ids = await referencedObjects(
      t,
      ada.id,
      MAX_NOTE_OBJECTS,
      hidden,
      visible,
    );
    const markdown = ["Copy", ...ids.map((id) => image(id))].join("\n\n");
    const { noteId } = await ben.as.mutation(api.notes.create, {
      clientKey: "copy",
      doc: docJson(markdown),
      sourceNoteId: visible,
    });
    // Recorded at once: nothing waits for verification.
    expect(await pendingChecks(t)).toEqual([]);
    expect(
      (await ben.as.query(api.files.noteObjects, { noteId }))!.length,
    ).toBe(MAX_NOTE_OBJECTS);
  }, 60_000);

  test("the ninth reference still counts (no silent cutoff)", async () => {
    const t = setup(true);
    const { ada, ben, hidden, visible } = await sharedFixture(t, 9);
    const [photo] = await referencedObjects(t, ada.id, 1, hidden, visible);
    const noteId = await createNote(ben.as, `Copy\n\n${image(photo!)}`);
    await settle(t);
    expect(
      (
        await ben.as.query(api.files.authorizeRead, {
          noteId,
          objectId: photo!,
        })
      ).access,
    ).toBe("granted");
  });

  test("a complete search that finds no access records nothing", async () => {
    const t = setup(true);
    const { ada, ben, hidden, visible } = await sharedFixture(t, 30);
    const other = await createNote(ada.as, "Also private");
    await t.run((ctx) => ctx.db.patch(other, { restricted: true }));
    const [photo] = await referencedObjects(t, ada.id, 1, hidden, other);
    const noteId = await createNote(ben.as, `Mine\n\n${image(photo!)}`);
    await settle(t);
    expect(await pendingChecks(t)).toEqual([]);
    expect((await refs(t, photo!)).some((r) => r.noteId === noteId)).toBe(
      false,
    );
    // A named source Ben can read but that does not contain it proves nothing.
    const again = await ben.as.mutation(api.notes.create, {
      clientKey: "again",
      doc: docJson(`Again\n\n${image(photo!)}`),
      sourceNoteId: visible,
    });
    await settle(t);
    expect((await refs(t, photo!)).some((r) => r.noteId === again.noteId)).toBe(
      false,
    );
  });

  test("pushes and agent edits can name source notes too", async () => {
    const t = setup(true);
    const { ada, ben, hidden, visible } = await sharedFixture(t, 9);
    await share(t, ben.notebookId, ada.id, "read", ben.id);
    const [photo] = await referencedObjects(t, ada.id, 1, hidden, visible);
    const noteId = await createNote(ben.as, "Mine");
    const content = (await ben.as.query(api.notes.content, { noteId }))!;
    const doc = notesSchema.nodeFromJSON(JSON.parse(content.doc));
    const tr = new Transform(doc).insert(
      doc.content.size,
      notesSchema.nodes.image!.create({ src: `attachment:${photo}` }),
    );
    await ben.as.mutation(api.notes.push, {
      noteId,
      revision: content.revision,
      steps: tr.steps.map((s) => JSON.stringify(s.toJSON())),
      clientId: "c1",
      sourceNoteIds: [visible],
    });
    expect(await pendingChecks(t)).toEqual([]);
    expect((await refs(t, photo!)).some((r) => r.noteId === noteId)).toBe(true);
  });
});

test("worst case: 200 attachments swapped for 200 others in one edit", async () => {
  // Index ranges are capped at 2,000. Gets are at most the ranges plus the
  // ~51 note lookups of the search, so gets and ranges together stay under
  // the 4,096 a deployment allows (arithmetic in references.ts).
  const t = setup({ databaseQueries: 2000 });
  const { ada, ben, hidden, visible } = await sharedFixture(t, 9);
  await share(t, ben.notebookId, ada.id, "edit", ben.id);
  const old = await referencedObjects(
    t,
    ada.id,
    MAX_NOTE_OBJECTS,
    hidden,
    visible,
  );
  const fresh = await referencedObjects(
    t,
    ada.id,
    MAX_NOTE_OBJECTS,
    hidden,
    visible,
  );
  const noteId = await createNote(ben.as, "Swap");
  const content = (await ben.as.query(api.notes.content, { noteId }))!;
  await ben.as.mutation(api.notes.edit, {
    noteId,
    expectedRevision: content.revision,
    edits: [
      {
        type: "replace_all",
        markdown: ["Swap", ...old.map((id) => image(id))].join("\n\n"),
      },
    ],
    sourceNoteIds: [visible],
  });
  const next = (await ben.as.query(api.notes.content, { noteId }))!;
  // Three readable named sources that do not contain the new objects, so
  // every check pays for them, falls through to the bounded search and then
  // to later verification.
  const decoys = [
    await createNote(ada.as, "Decoy 1"),
    await createNote(ada.as, "Decoy 2"),
    await createNote(ada.as, "Decoy 3"),
  ];
  await ben.as.mutation(api.notes.edit, {
    noteId,
    expectedRevision: next.revision,
    edits: [
      {
        type: "replace_all",
        markdown: ["Swap", ...fresh.map((id) => image(id))].join("\n\n"),
      },
    ],
    sourceNoteIds: decoys,
  });
  await settle(t);
  expect(await pendingChecks(t)).toEqual([]);
  const objects = (await ben.as.query(api.files.noteObjects, { noteId }))!;
  expect(new Set(objects.map((o) => o.objectId))).toEqual(new Set(fresh));
}, 120_000);

describe("F2: every accepted revision records its references", () => {
  test("an attachment added and removed in one push keeps a history reference", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    await share(t, ada.notebookId, ben.id, "edit", ada.id);
    const noteId = await createNote(ada.as, "Note");
    const photo = await upload(t, ada.as, { noteId });
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    const doc = notesSchema.nodeFromJSON(JSON.parse(content.doc));
    const tr = new Transform(doc);
    tr.insert(
      doc.content.size,
      notesSchema.nodes.image!.create({ src: `attachment:${photo}` }),
    );
    tr.delete(doc.content.size, tr.doc.content.size);
    expect(tr.steps).toHaveLength(2);
    await ada.as.mutation(api.notes.push, {
      noteId,
      revision: content.revision,
      steps: tr.steps.map((s) => JSON.stringify(s.toJSON())),
      clientId: "c1",
    });
    // Revision 1 contained it: a history reference, not a current one.
    expect(await refs(t, photo)).toMatchObject([
      { noteId, current: false, live: false },
    ]);
    expect(
      (await ben.as.query(api.files.authorizeRead, { noteId, objectId: photo }))
        .access,
    ).toBe("granted");
    const past = await ben.as.query(api.history.read, { noteId, revision: 1 });
    expect(past.markdown).toContain(`attachment:${photo}`);
    // Trash retention applies, not the never-referenced cleanup.
    vi.advanceTimersByTime(10 * DAY);
    await t.mutation(internal.files.purgeExpired, {});
    expect(await object(t, photo)).not.toBeNull();
    vi.advanceTimersByTime(21 * DAY);
    await t.mutation(internal.files.purgeExpired, {});
    expect(await object(t, photo)).toBeNull();
  });

  test("an attachment added mid-push and kept is current", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const a = await upload(t, ada.as, { noteId }, "a");
    const b = await upload(t, ada.as, { noteId }, "b");
    const content = (await ada.as.query(api.notes.content, { noteId }))!;
    const doc = notesSchema.nodeFromJSON(JSON.parse(content.doc));
    const tr = new Transform(doc);
    const end = doc.content.size;
    tr.insert(end, notesSchema.nodes.image!.create({ src: `attachment:${a}` }));
    // Changing the image's source swaps the object within the push.
    tr.setNodeAttribute(end, "src", `attachment:${b}`);
    await ada.as.mutation(api.notes.push, {
      noteId,
      revision: content.revision,
      steps: tr.steps.map((s) => JSON.stringify(s.toJSON())),
      clientId: "c1",
    });
    expect(await refs(t, a)).toMatchObject([{ current: false }]);
    expect(await refs(t, b)).toMatchObject([{ current: true, live: true }]);
    expect((await object(t, b))!.trashedAt).toBeUndefined();
    expect((await object(t, a))!.trashedAt).toBeDefined();
  });
});

describe("F3: no write can land after its deletion was swept", () => {
  async function admitted(t: T) {
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const granted = await ticket(ada.as, { noteId }, "bytes");
    const admission = await service(t).mutation(api.files.admitUpload, {
      objectId: granted.objectId,
      ticket: granted.ticket!,
    });
    return { ada, noteId, granted, admission };
  }

  test("admission grants a lease the Worker must write within", async () => {
    const t = setup(true);
    const { admission } = await admitted(t);
    expect(admission).toMatchObject({
      status: "pending",
      leaseUntil: Date.now() + UPLOAD_LEASE_MS,
    });
  });

  test("cancelling during a lease defers the byte deletion past it", async () => {
    const t = setup(true);
    const { ada, granted, admission } = await admitted(t);
    await ada.as.mutation(api.files.cancelUpload, {
      objectId: granted.objectId,
    });
    const leaseUntil = (admission as { leaseUntil: number }).leaseUntil;
    const due = () => service(t).query(api.files.deletionBatch, { limit: 100 });
    // Not handed to the sweep while a late write could still land.
    expect(await due()).toEqual([]);
    vi.setSystemTime(leaseUntil + WRITE_SETTLE_MS - 1);
    expect(await due()).toEqual([]);
    vi.setSystemTime(leaseUntil + WRITE_SETTLE_MS);
    expect((await due()).map((row) => row.key)).toEqual([
      `objects/${granted.objectId}`,
    ]);
    // A failed object is never admitted again.
    expect(
      await service(t).mutation(api.files.admitUpload, {
        objectId: granted.objectId,
        ticket: granted.ticket!,
      }),
    ).toEqual({ status: "gone" });
    // Removing the failed record keeps the pending deletion.
    vi.advanceTimersByTime(2 * DAY);
    await t.mutation(internal.files.expireUploads, {});
    expect(await object(t, granted.objectId)).toBeNull();
    expect(await deletions(t)).toEqual([`objects/${granted.objectId}`]);
  });

  test("purging an object deletes its bytes only after any lease", async () => {
    const t = setup(true);
    const { ada, granted, admission } = await admitted(t);
    // Another request finalizes while this admission's write is in flight.
    await service(t).mutation(api.files.finalize, {
      objectId: granted.objectId,
      ticket: granted.ticket!,
      size: 5,
      sha256: await sha256("bytes"),
    });
    await ada.as.mutation(api.files.cancelUpload, {
      objectId: granted.objectId,
    });
    expect(await object(t, granted.objectId)).toBeNull();
    const leaseUntil = (admission as { leaseUntil: number }).leaseUntil;
    expect(
      await service(t).query(api.files.deletionBatch, { limit: 100 }),
    ).toEqual([]);
    vi.setSystemTime(leaseUntil + WRITE_SETTLE_MS);
    expect(
      (await service(t).query(api.files.deletionBatch, { limit: 100 })).map(
        (row) => row.key,
      ),
    ).toEqual([`objects/${granted.objectId}`]);
  });

  test("ready objects need no lease", async () => {
    const t = setup(true);
    const { granted } = await admitted(t);
    await service(t).mutation(api.files.finalize, {
      objectId: granted.objectId,
      ticket: granted.ticket!,
      size: 5,
      sha256: await sha256("bytes"),
    });
    expect(
      await service(t).mutation(api.files.admitUpload, {
        objectId: granted.objectId,
        ticket: granted.ticket!,
      }),
    ).toEqual({ status: "ready", size: 5, sha256: await sha256("bytes") });
  });
});

describe("F7: legacy attachment sources", () => {
  /** A note whose stored content has an image source only the old rule allowed. */
  async function legacyNote(t: T) {
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
      await ctx.db.insert("noteCheckpoints", {
        noteId,
        revision: 0,
        doc: JSON.stringify(legacy),
      });
    });
    return { ada, noteId };
  }

  test("stored notes with legacy sources still open and edit", async () => {
    const t = setup(true);
    const { ada, noteId } = await legacyNote(t);
    const read = await ada.as.query(api.notes.readMarkdown, {
      noteId,
      format: "markdown",
    });
    expect(read.markdown).toContain("Legacy");
    const edited = await ada.as.mutation(api.notes.edit, {
      noteId,
      edits: [{ type: "append", markdown: "More." }],
    });
    expect(edited.revision).toBeGreaterThan(0);
    const after = await ada.as.query(api.notes.readMarkdown, {
      noteId,
      format: "markdown",
    });
    expect(after.markdown).toContain("More.");
    // It grants nothing: no reference is recorded for it.
    expect(await t.run((ctx) => ctx.db.query("objectRefs").collect())).toEqual(
      [],
    );
  });

  test("new content cannot use legacy sources", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const loose = JSON.stringify({
      type: "doc",
      content: [
        { type: "image", attrs: { id: "i1", src: "Attachment:Some/Old-ID" } },
      ],
    });
    await expect(
      ada.as.mutation(api.notes.create, { clientKey: "k", doc: loose }),
    ).rejects.toThrow(/not valid/);
  });

  test("the operator scan finds legacy sources in content and history", async () => {
    const t = setup(true);
    const { noteId } = await legacyNote(t);
    await t.run(async (ctx) =>
      ctx.db.insert("noteSteps", {
        noteId,
        revision: 1,
        clientId: "c",
        actorId: (await ctx.db.get(noteId))!.ownerId,
        step: JSON.stringify({
          stepType: "attr",
          pos: 0,
          attr: "src",
          value: "attachment:../x",
        }),
      }),
    );
    const scan = async (
      table: "noteContent" | "noteCheckpoints" | "noteSteps",
    ) => {
      const found: { noteId: string }[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page: {
          loose: { noteId: string }[];
          isDone: boolean;
          continueCursor: string;
        } = await t.query(internal.files.scanAttachmentSources, {
          table,
          cursor,
          numItems: 50,
        });
        found.push(...page.loose);
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      return found;
    };
    expect(await scan("noteContent")).toEqual([
      { noteId, revision: null, sources: 1 },
    ]);
    expect(await scan("noteCheckpoints")).toEqual([
      { noteId, revision: 0, sources: 1 },
    ]);
    expect(await scan("noteSteps")).toEqual([
      { noteId, revision: 1, sources: 1 },
    ]);
  });
});
