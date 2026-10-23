/// <reference types="vite/client" />
// Regression tests for review round 3 of B1+B2
// (docs/reviews/notes-files-backend-round3-astra-review.md).
import { notesSchema } from "@palladian/notes-core";
import type { FunctionReference } from "convex/server";
import { Transform } from "prosemirror-transform";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { UPLOAD_LEASE_MS } from "../convex/files";
import {
  AGENT_ISSUER,
  createNote,
  deletions,
  docJson,
  human,
  image,
  object,
  refs,
  replaceAll,
  service,
  setup,
  share,
  ticket,
  upload,
  type As,
  type T,
} from "./files-harness";
import {
  storeObject,
  type BridgeBucket,
  type BridgeCaller,
} from "./worker-bridge.mjs";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  process.env.FILES_WRITES_ENABLED = "true";
});

/** An in-memory bucket; one write can be held in flight until released. */
class Bucket implements BridgeBucket {
  readonly objects = new Map<string, Uint8Array>();
  private held: { started: () => void; done: Promise<void> } | null = null;
  holdNextWrite() {
    let release = () => {};
    let started = () => {};
    const done = new Promise<void>((resolve) => (release = resolve));
    const writeStarted = new Promise<void>((resolve) => (started = resolve));
    this.held = { started, done };
    return { writeStarted, release };
  }
  async put(key: string, value: Uint8Array) {
    const held = this.held;
    this.held = null;
    if (held) {
      held.started();
      await held.done;
    }
    this.objects.set(key, new Uint8Array(value));
    return {};
  }
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.objects.delete(key);
  }
  async head(key: string) {
    return this.objects.has(key) ? {} : null;
  }
}

/** The Worker's Convex calls, as the file service, against this deployment. */
function serviceCaller(t: T): BridgeCaller {
  const as = service(t);
  type Call = (fn: unknown, args: unknown) => Promise<unknown>;
  return {
    query: (fn, args) =>
      (as.query as unknown as Call).call(
        as,
        fn as FunctionReference<"query">,
        args,
      ),
    mutation: (fn, args) =>
      (as.mutation as unknown as Call).call(
        as,
        fn as FunctionReference<"mutation">,
        args,
      ),
  };
}

function workerEnv(bucket: Bucket) {
  return {
    FILES: bucket,
    CONVEX_URL: "https://unused.example",
    AGENT_JWT_PRIVATE_KEY: "",
    AGENT_JWT_ISSUER: AGENT_ISSUER,
  };
}

describe("R3-1: only Convex decides that bytes go", () => {
  test("a late original write never removes a ready object's bytes", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const content = new TextEncoder().encode("the photo's bytes");
    const request = { requestId: "the-upload-request" };
    const first = await ticket(
      ada.as,
      { noteId },
      "the photo's bytes",
      request,
    );
    const bucket = new Bucket();
    const env = workerEnv(bucket);
    const deps = { service: async () => serviceCaller(t) };
    // The original upload is admitted and its write is in flight.
    const held = bucket.holdNextWrite();
    const original = storeObject(
      env,
      first.objectId,
      first.ticket!,
      async () => content,
      deps,
    );
    await held.writeStarted;
    // Five retries of the same request: fresh tickets, the first evicted.
    let latest = first;
    for (let i = 0; i < 5; i++)
      latest = await ticket(ada.as, { noteId }, "the photo's bytes", request);
    expect(latest.objectId).toBe(first.objectId);
    // A retry uploads and finalizes.
    expect(
      await storeObject(
        env,
        latest.objectId,
        latest.ticket!,
        async () => content,
        deps,
      ),
    ).toMatchObject({ ok: true });
    // The original write lands after its lease; finalize refuses its old
    // ticket. Nothing may delete the bytes.
    vi.advanceTimersByTime(UPLOAD_LEASE_MS + 60_000);
    held.release();
    expect((await original).ok).toBe(false);
    expect((await object(t, first.objectId))!.state).toBe("ready");
    // Per-object key, verified bytes: the late write rewrote the same bytes.
    expect(bucket.objects.get(`objects/${first.objectId}`)).toEqual(content);
    expect(await deletions(t)).toEqual([]);
    expect(
      await service(t).mutation(api.files.deletionBatch, { limit: 100 }),
    ).toEqual([]);
  });

  test("the sweep deletes only for objects gone or failed at sweep time", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Note");
    const ready = await upload(t, ada.as, { noteId }, "ready");
    const pending = await ticket(ada.as, { noteId }, "pending");
    const failed = await ticket(ada.as, { noteId }, "failed");
    await ada.as.mutation(api.files.cancelUpload, {
      objectId: failed.objectId,
    });
    const purged = await upload(t, ada.as, { noteId }, "purged");
    await ada.as.mutation(api.files.cancelUpload, { objectId: purged });
    // Tombstones for live objects can only come from a mistake; even then
    // their bytes stay.
    await t.run(async (ctx) => {
      for (const objectId of [ready, pending.objectId])
        await ctx.db.insert("objectDeletions", {
          key: `objects/${objectId}`,
          requestedAt: Date.now(),
          notBefore: Date.now(),
          retainUntil: Date.now(),
          passes: 0,
        });
    });
    const batch = await service(t).mutation(api.files.deletionBatch, {
      limit: 100,
    });
    expect(new Set(batch.map((row) => row.key))).toEqual(
      new Set([`objects/${failed.objectId}`, `objects/${purged}`]),
    );
    // The live objects' tombstones were retired without a deletion.
    expect(new Set(await deletions(t))).toEqual(
      new Set([`objects/${failed.objectId}`, `objects/${purged}`]),
    );
  });
});

describe("R3-2: a named source counts as reads do", () => {
  test("an editor may copy from a source's history; a reader may not", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const ben = await human(t, "Ben");
    const cy = await human(t, "Cy");
    await share(t, ada.notebookId, ben.id, "edit", ada.id);
    await share(t, ada.notebookId, cy.id, "read", ada.id);
    const source = await createNote(ada.as, "Source");
    const privateBook = await ada.as.mutation(api.notebooks.create, {
      name: "Private",
    });
    const hidden: Id<"notes">[] = [];
    for (let i = 0; i < 48; i++)
      hidden.push(
        (
          await ada.as.mutation(api.notes.create, {
            clientKey: `hidden-${i}`,
            notebookId: privateBook,
            doc: docJson(`Hidden ${i}`),
          })
        ).noteId,
      );
    // 48 current references nobody else can read, and the source's history.
    const photo = await t.run(async (ctx) => {
      const objectId = await ctx.db.insert("objects", {
        ownerId: ada.id,
        uploaderId: ada.id,
        name: "p.png",
        mimeType: "image/png",
        size: 1,
        sha256: "0".repeat(64),
        state: "ready",
        ticketHashes: [],
        createdAt: Date.now(),
      });
      for (const noteId of hidden)
        await ctx.db.insert("objectRefs", {
          noteId,
          objectId,
          current: true,
          live: true,
        });
      await ctx.db.insert("objectRefs", {
        noteId: source,
        objectId,
        current: false,
        live: false,
      });
      return objectId;
    });
    const copyAs = async (as: As, key: string) =>
      (
        await as.mutation(api.notes.create, {
          clientKey: key,
          doc: docJson(`Copy\n\n${image(photo)}`),
          sourceNoteId: source,
        })
      ).noteId;
    const bens = await copyAs(ben.as, "ben-copy");
    expect(
      (
        await ben.as.query(api.files.authorizeRead, {
          noteId: source,
          objectId: photo,
        })
      ).access,
    ).toBe("granted");
    expect(
      (
        await ben.as.query(api.files.authorizeRead, {
          noteId: bens,
          objectId: photo,
        })
      ).access,
    ).toBe("granted");
    expect((await refs(t, photo)).find((r) => r.noteId === bens)).toMatchObject(
      { proof: "source", proofNoteId: source },
    );
    const cys = await copyAs(cy.as, "cy-copy");
    expect(
      (
        await cy.as.query(api.files.authorizeRead, {
          noteId: cys,
          objectId: photo,
        })
      ).access,
    ).toBe("denied");
  });
});

describe("R3-3: files stay off until FILES_WRITES_ENABLED", () => {
  const off = () => {
    process.env.FILES_WRITES_ENABLED = "false";
  };
  const on = () => {
    process.env.FILES_WRITES_ENABLED = "true";
  };

  async function pushSteps(
    as: As,
    noteId: Id<"notes">,
    edit: (tr: Transform) => void,
  ) {
    const content = (await as.query(api.notes.content, { noteId }))!;
    const tr = new Transform(notesSchema.nodeFromJSON(JSON.parse(content.doc)));
    edit(tr);
    return await as.mutation(api.notes.push, {
      noteId,
      revision: content.revision,
      steps: tr.steps.map((s) => JSON.stringify(s.toJSON())),
      clientId: "c1",
    });
  }

  test("while off, every write of file features is refused; reads and other edits work", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const noteId = await createNote(ada.as, "Album");
    // Made while files were on.
    const photo = await upload(t, ada.as, { noteId }, "photo");
    const spare = await upload(t, ada.as, { noteId }, "spare");
    const pendingTicket = await ticket(ada.as, { noteId }, "later");
    await replaceAll(ada.as, noteId, `Album\n\n${image(photo)}`);
    const withPhoto = (await ada.as.query(api.notes.content, { noteId }))!
      .revision;
    await replaceAll(ada.as, noteId, "Album");
    await replaceAll(ada.as, noteId, `Album\n\n${image(photo)}`);

    off();
    const refused = /not enabled/;
    await expect(ticket(ada.as, { noteId }, "new")).rejects.toThrow(refused);
    await expect(
      service(t).mutation(api.files.admitUpload, {
        objectId: pendingTicket.objectId,
        ticket: pendingTicket.ticket!,
      }),
    ).rejects.toThrow(refused);
    // New content with an attachment, a width or a file block.
    await expect(
      pushSteps(ada.as, noteId, (tr) =>
        tr.insert(
          tr.doc.content.size,
          notesSchema.nodes.image!.create({ src: `attachment:${spare}` }),
        ),
      ),
    ).rejects.toThrow(refused);
    await expect(
      pushSteps(ada.as, noteId, (tr) =>
        tr.setNodeAttribute(tr.doc.child(0).nodeSize, "width", 300),
      ),
    ).rejects.toThrow(refused);
    await expect(
      ada.as.mutation(api.notes.create, {
        clientKey: "file",
        doc: docJson(`File\n\n[a.pdf](attachment:${spare})`),
      }),
    ).rejects.toThrow(refused);
    await expect(
      ada.as.mutation(api.notes.createFromMarkdown, {
        markdown: "Web\n\n![x](https://example.com/x.png){width=300}",
      }),
    ).rejects.toThrow(refused);
    await expect(
      ada.as.mutation(api.notes.edit, {
        noteId,
        edits: [{ type: "append", markdown: `[a.pdf](attachment:${spare})` }],
      }),
    ).rejects.toThrow(refused);
    // Restoring a revision would bring one back too.
    const current = (await ada.as.query(api.notes.content, { noteId }))!;
    await replaceAll(ada.as, noteId, "Album, emptied");
    const emptied = (await ada.as.query(api.notes.content, { noteId }))!;
    expect(emptied.revision).toBeGreaterThan(current.revision);
    await expect(
      ada.as.mutation(api.history.restore, {
        noteId,
        revision: withPhoto,
        expectedRevision: emptied.revision,
      }),
    ).rejects.toThrow(refused);

    // Unaffected: reads, other edits, web images without a width.
    expect(
      (
        await ada.as.query(api.files.authorizeRead, {
          noteId,
          objectId: photo,
        })
      ).access,
    ).toBe("granted");
    expect(await ada.as.query(api.files.noteObjects, { noteId })).toEqual([]);
    await ada.as.mutation(api.notes.edit, {
      noteId,
      edits: [{ type: "append", markdown: "Plain text is fine." }],
    });
    await ada.as.mutation(api.notes.createFromMarkdown, {
      markdown: "Web\n\n![x](https://example.com/x.png)",
    });

    // On: the same writes work.
    on();
    await ada.as.mutation(api.history.restore, {
      noteId,
      revision: withPhoto,
      expectedRevision: (await ada.as.query(api.notes.content, { noteId }))!
        .revision,
    });
    expect(
      (await ada.as.query(api.files.noteObjects, { noteId }))!.map(
        (o) => o.objectId,
      ),
    ).toEqual([photo]);
    await pushSteps(ada.as, noteId, (tr) =>
      tr.setNodeAttribute(tr.doc.child(0).nodeSize, "width", 300),
    );
    expect((await ticket(ada.as, { noteId }, "new")).state).toBe("pending");
    expect(
      (
        await service(t).mutation(api.files.admitUpload, {
          objectId: pendingTicket.objectId,
          ticket: pendingTicket.ticket!,
        })
      ).status,
    ).toBe("pending");
  });
});
