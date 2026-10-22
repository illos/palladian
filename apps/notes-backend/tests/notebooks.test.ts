/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";

const AGENT_ISSUER = "https://agent.test";
process.env.AGENT_JWT_ISSUER = AGENT_ISSUER;

const modules = import.meta.glob([
  "../convex/**/*.ts",
  "!../convex/betterAuth/**",
]);
const authModules = import.meta.glob("../convex/betterAuth/**/*.ts");

function setup(limits = false) {
  const t = convexTest({ schema, modules, transactionLimits: limits });
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}
type T = ReturnType<typeof setup>;

/** A person with a live session and a default notebook, "Notes". */
async function human(t: T, name: string) {
  const now = Date.now();
  const made = await t.run(async (ctx) => {
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name,
          email: name.toLowerCase() + "@example.com",
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
            expiresAt: now + 86_400_000,
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    )) as { _id: string };
    const principalId = await ctx.db.insert("principals", {
      kind: "human",
      name,
      email: name.toLowerCase() + "@example.com",
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
      principalId,
      notebookId,
      userId: user._id,
      sessionId: session._id,
    };
  });
  return {
    id: made.principalId,
    notebookId: made.notebookId,
    email: name.toLowerCase() + "@example.com",
    as: t.withIdentity({
      subject: made.userId,
      sessionId: made.sessionId,
      issuer: "https://site.test",
    }),
  };
}
type Person = Awaited<ReturnType<typeof human>>;

async function agent(
  t: T,
  controllerId: Id<"principals">,
  delegations: ("share" | "move" | "delete" | "publish")[],
) {
  const made = await t.run(async (ctx) => {
    const agentId = await ctx.db.insert("principals", {
      kind: "agent",
      name: "Claude",
      controllerId,
      delegations,
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
    return { agentId, connectionId };
  });
  return {
    id: made.agentId,
    as: t.withIdentity({
      issuer: AGENT_ISSUER,
      subject: made.agentId,
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
  return t.run((ctx) =>
    ctx.db.insert("notebookMembers", {
      notebookId,
      principalId,
      role,
      grantedBy: by,
      createdAt: Date.now(),
    }),
  );
}

async function notebook(person: Person, name: string) {
  return await person.as.mutation(api.notebooks.create, { name });
}

async function note(
  person: Person,
  notebookId: Id<"notebooks">,
  markdown: string,
) {
  return (
    await person.as.mutation(api.notes.createFromMarkdown, {
      notebookId,
      markdown,
    })
  ).noteId;
}

/** Delete a notebook the way the app does: repeat until done. */
async function removeAll(
  person: Person,
  notebookId: Id<"notebooks">,
  destinationId: Id<"notebooks">,
  trash: boolean,
) {
  const calls = [];
  for (let i = 0; i < 100; i++) {
    const result = await person.as.mutation(api.notebooks.remove, {
      notebookId,
      destinationId,
      trash,
    });
    calls.push(result);
    if (result.done) return calls;
  }
  throw new Error("Deletion did not finish.");
}

function row<Table extends "notes" | "notebooks">(t: T, id: Id<Table>) {
  return t.run((ctx) => ctx.db.get(id));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("notebook deletion", () => {
  test("only the owner, signed in as a person, may delete a notebook", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const cy = await human(t, "Cy");
    const dee = await human(t, "Dee");
    const journal = await notebook(ada, "Journal");
    const kept = await note(ada, journal, "Kept");
    await share(t, journal, bea.id, "edit", ada.id);
    await share(t, journal, cy.id, "read", ada.id);
    const claude = await agent(t, ada.id, [
      "share",
      "move",
      "delete",
      "publish",
    ]);
    await share(t, journal, claude.id, "edit", ada.id);
    const args = {
      notebookId: journal,
      destinationId: ada.notebookId,
      trash: false,
    };
    await expect(bea.as.mutation(api.notebooks.remove, args)).rejects.toThrow(
      /Only the notebook's owner/,
    );
    await expect(cy.as.mutation(api.notebooks.remove, args)).rejects.toThrow(
      /Only the notebook's owner/,
    );
    // Delegation covers owner actions on notes, not deleting notebooks.
    await expect(
      claude.as.mutation(api.notebooks.remove, args),
    ).rejects.toThrow(/Only people/);
    await expect(t.mutation(api.notebooks.remove, args)).rejects.toThrow(
      /Sign in/,
    );
    // Someone who cannot see the notebook learns nothing and changes nothing.
    expect(await dee.as.mutation(api.notebooks.remove, args)).toEqual({
      done: true,
      notes: 0,
    });
    expect(await row(t, journal)).not.toBeNull();
    expect((await row(t, kept))!.notebookId).toBe(journal);

    const calls = await removeAll(ada, journal, ada.notebookId, false);
    expect(calls.at(-1)).toEqual({ done: true, notes: 0 });
    expect(await row(t, journal)).toBeNull();
    expect((await row(t, kept))!.notebookId).toBe(ada.notebookId);
  });

  test("the default notebook is refused until another is chosen", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const journal = await notebook(ada, "Journal");
    const first = await note(ada, ada.notebookId, "First");
    await expect(
      ada.as.mutation(api.notebooks.remove, {
        notebookId: ada.notebookId,
        destinationId: journal,
        trash: false,
      }),
    ).rejects.toThrow(/default notebook/);
    expect((await row(t, first))!.notebookId).toBe(ada.notebookId);
    await ada.as.mutation(api.notebooks.setDefault, { notebookId: journal });
    await removeAll(ada, ada.notebookId, journal, false);
    expect(await row(t, ada.notebookId)).toBeNull();
    expect((await row(t, first))!.notebookId).toBe(journal);
  });

  test("notes go only to another notebook the caller owns", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const journal = await notebook(ada, "Journal");
    await note(ada, journal, "First");
    // Even a notebook Ada may edit is not hers to receive her notes.
    await share(t, bea.notebookId, ada.id, "edit", bea.id);
    for (const destinationId of [journal, bea.notebookId])
      await expect(
        ada.as.mutation(api.notebooks.remove, {
          notebookId: journal,
          destinationId,
          trash: false,
        }),
      ).rejects.toThrow(/another of your notebooks/);
    expect(await row(t, journal)).not.toBeNull();
  });

  test("moving keeps notes, history, pins and grants; positions go and feeds follow", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const cy = await human(t, "Cy");
    const journal = await notebook(ada, "Journal");
    await share(t, journal, bea.id, "edit", ada.id);
    const first = await note(ada, journal, "First");
    const second = await note(ada, journal, "Second");
    await ada.as.mutation(api.sharing.setNoteMember, {
      noteId: second,
      principalId: cy.id,
      role: "read",
    });
    for (const person of [ada, bea]) {
      await person.as.mutation(api.arrangement.setPin, {
        noteId: first,
        pinned: true,
      });
      await person.as.mutation(api.arrangement.setPositions, {
        notebookId: journal,
        entries: [
          { noteId: first, key: "V" },
          { noteId: second, key: "k" },
        ],
      });
    }
    await removeAll(ada, journal, ada.notebookId, false);
    // Moved notes' old positions go in scheduled batches, as with any move.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const id of [first, second]) {
      const moved = (await row(t, id))!;
      expect(moved).toMatchObject({
        notebookId: ada.notebookId,
        lifecycle: "active",
        restricted: false,
      });
    }
    const left = await t.run(async (ctx) => ({
      text: await ctx.db
        .query("noteText")
        .withIndex("by_note", (q) => q.eq("noteId", first))
        .unique(),
      versions: await ctx.db
        .query("noteVersions")
        .withIndex("by_note_and_revision", (q) => q.eq("noteId", first))
        .collect(),
      pins: await ctx.db
        .query("pins")
        .withIndex("by_note", (q) => q.eq("noteId", first))
        .collect(),
      positions: await ctx.db.query("notePositions").collect(),
    }));
    expect(left.text!.notebookId).toBe(ada.notebookId);
    expect(left.versions.length).toBeGreaterThan(0);
    expect(left.pins).toHaveLength(2);
    expect(left.positions).toEqual([]);
    // The explicit grant still governs; Bea lost what she had through Journal.
    expect(
      (await cy.as.query(api.notes.get, { noteId: second }))!.summary.role,
    ).toBe("read");
    expect(await bea.as.query(api.notes.get, { noteId: first })).toBeNull();
    const feed = await ada.as.query(api.library.changes, {
      notebookId: ada.notebookId,
      after: 0,
    });
    expect(feed.access && feed.notes.map((n) => n.id).sort()).toEqual(
      [first, second].sort(),
    );
    expect(
      await ada.as.query(api.library.changes, {
        notebookId: journal,
        after: 0,
      }),
    ).toEqual({ access: false });
  });

  test("to Trash: notes are filed in the destination, private if it has members", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const cy = await human(t, "Cy");
    // A destination nobody else can open: notes keep their sharing.
    const journal = await notebook(ada, "Journal");
    const active = await note(ada, journal, "Active");
    const earlier = await note(ada, journal, "Earlier");
    await ada.as.mutation(api.notes.trash, { noteId: earlier });
    const trashedAt = (await row(t, earlier))!.trashedAt;
    vi.advanceTimersByTime(60_000);
    await removeAll(ada, journal, ada.notebookId, true);
    expect(await row(t, active)).toMatchObject({
      notebookId: ada.notebookId,
      lifecycle: "trashed",
      restricted: false,
    });
    expect((await row(t, active))!.trashedAt).toBeGreaterThan(trashedAt!);
    // Already in Trash: its retention keeps counting from when it went there.
    expect(await row(t, earlier)).toMatchObject({
      notebookId: ada.notebookId,
      lifecycle: "trashed",
      trashedAt,
    });
    const text = await t.run((ctx) =>
      ctx.db
        .query("noteText")
        .withIndex("by_note", (q) => q.eq("noteId", active))
        .unique(),
    );
    expect(text).toMatchObject({ notebookId: ada.notebookId, trashed: true });

    // A shared destination: its members gain nothing from the deletion.
    await share(t, ada.notebookId, bea.id, "edit", ada.id);
    const diary = await notebook(ada, "Diary");
    const secret = await note(ada, diary, "Secret");
    await ada.as.mutation(api.sharing.setNoteMember, {
      noteId: secret,
      principalId: cy.id,
      role: "read",
    });
    expect(
      await ada.as.query(api.notebooks.deletePreview, {
        notebookId: diary,
        destinationId: ada.notebookId,
        trash: true,
      }),
    ).toEqual({
      destinationId: ada.notebookId,
      trash: true,
      lost: [],
      destinationShared: true,
      complete: true,
    });
    await removeAll(ada, diary, ada.notebookId, true);
    expect(await row(t, secret)).toMatchObject({
      notebookId: ada.notebookId,
      lifecycle: "trashed",
      restricted: true,
    });
    expect(await bea.as.query(api.notes.get, { noteId: secret })).toBeNull();
    // An explicit grant is kept, as with any trashed note.
    expect(
      (await cy.as.query(api.notes.get, { noteId: secret }))!.summary,
    ).toMatchObject({ role: "read", trashed: true });
    // Restoring returns it to the destination, still private.
    await ada.as.mutation(api.notes.restore, { noteId: secret });
    expect(await row(t, secret)).toMatchObject({
      notebookId: ada.notebookId,
      lifecycle: "active",
      restricted: true,
    });
    expect(await bea.as.query(api.notes.get, { noteId: secret })).toBeNull();
  });

  test("restricted notes, overrides and notes already in Trash keep their rules when moved", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const cy = await human(t, "Cy");
    const journal = await notebook(ada, "Journal");
    await share(t, journal, bea.id, "edit", ada.id);
    await share(t, journal, cy.id, "read", ada.id);
    await share(t, ada.notebookId, bea.id, "edit", ada.id);
    const restricted = await note(ada, journal, "Restricted");
    await ada.as.mutation(api.sharing.setNoteRestricted, {
      noteId: restricted,
      restricted: true,
    });
    await ada.as.mutation(api.sharing.setNoteMember, {
      noteId: restricted,
      principalId: cy.id,
      role: "read",
    });
    const denied = await note(ada, journal, "Denied");
    await ada.as.mutation(api.sharing.setNoteMember, {
      noteId: denied,
      principalId: bea.id,
      role: "none",
    });
    const plain = await note(ada, journal, "Plain");
    const binned = await note(ada, journal, "Binned");
    await ada.as.mutation(api.notes.trash, { noteId: binned });
    // Bea is also in the destination, but loses the note already in Trash,
    // which becomes private there; Cy is not in the destination.
    expect(
      await ada.as.query(api.notebooks.deletePreview, {
        notebookId: journal,
        destinationId: ada.notebookId,
        trash: false,
      }),
    ).toEqual({
      destinationId: ada.notebookId,
      trash: false,
      lost: [
        { principalId: bea.id, name: "Bea" },
        { principalId: cy.id, name: "Cy" },
      ],
      destinationShared: true,
      complete: true,
    });
    expect(
      (await ada.as.query(api.notebooks.deletePreview, {
        notebookId: journal,
        destinationId: ada.notebookId,
        trash: true,
      }))!.lost.map((p) => p.name),
    ).toEqual(["Bea", "Cy"]);
    await removeAll(ada, journal, ada.notebookId, false);

    const role = async (person: Person, noteId: Id<"notes">) =>
      (await person.as.query(api.notes.get, { noteId }))?.summary.role ?? null;
    expect((await row(t, restricted))!.restricted).toBe(true);
    expect(await role(cy, restricted)).toBe("read");
    expect(await role(bea, restricted)).toBeNull();
    expect(await role(bea, denied)).toBeNull();
    expect(await role(cy, denied)).toBeNull();
    expect(await role(bea, plain)).toBe("edit");
    expect(await role(cy, plain)).toBeNull();
    // A note already in Trash stays there, private in the shared destination.
    expect(await row(t, binned)).toMatchObject({
      notebookId: ada.notebookId,
      lifecycle: "trashed",
      restricted: true,
    });
    expect(await role(bea, binned)).toBeNull();
    expect((await row(t, plain))!.restricted).toBe(false);
  });

  test("a note owned by someone else stops the deletion", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const journal = await notebook(ada, "Journal");
    // Not reachable through the app (notes belong to their notebook's owner
    // and move only between one owner's notebooks); written directly.
    const foreign = await t.run((ctx) =>
      ctx.db.insert("notes", {
        notebookId: journal,
        ownerId: bea.id,
        creatorId: bea.id,
        title: "Bea's",
        preview: "",
        createdAt: Date.now(),
        editedAt: Date.now(),
        lifecycle: "active",
        restricted: false,
        seq: 0,
      }),
    );
    const own = await note(ada, journal, "Ada's");
    await expect(
      ada.as.mutation(api.notebooks.remove, {
        notebookId: journal,
        destinationId: ada.notebookId,
        trash: false,
      }),
    ).rejects.toThrow(/owned by someone else/);
    expect(await row(t, journal)).not.toBeNull();
    expect((await row(t, foreign))!.notebookId).toBe(journal);
    expect((await row(t, own))!.notebookId).toBe(journal);
  });

  test("memberships, open invitations, orders and positions go, for everyone", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const cy = await human(t, "Cy");
    const journal = await notebook(ada, "Journal");
    const first = await note(ada, journal, "First");
    await share(t, journal, bea.id, "edit", ada.id);
    const invited = await ada.as.mutation(api.invitations.create, {
      email: "new@example.com",
      notebookId: journal,
      role: "read",
    });
    // An existing account is granted at once; the invitation is accepted.
    await ada.as.mutation(api.invitations.create, {
      email: cy.email,
      notebookId: journal,
      role: "read",
    });
    const elsewhere = await ada.as.mutation(api.invitations.create, {
      email: "other@example.com",
      notebookId: ada.notebookId,
      role: "read",
    });
    for (const [person, order] of [
      [ada, "alpha"],
      [bea, "custom"],
      [cy, "created"],
    ] as const)
      await person.as.mutation(api.arrangement.setOrder, {
        list: journal,
        order,
      });
    await ada.as.mutation(api.arrangement.setOrder, {
      list: "all",
      order: "alpha",
    });
    await bea.as.mutation(api.arrangement.setPositions, {
      notebookId: journal,
      entries: [{ noteId: first, key: "V" }],
    });
    // Cy leaves; the order he set stays behind until the notebook goes.
    await ada.as.mutation(api.sharing.setNotebookMember, {
      notebookId: journal,
      principalId: cy.id,
      role: null,
    });
    // A stale position row for the notebook, as an older client could leave.
    const other = await note(ada, ada.notebookId, "Other");
    await t.run((ctx) =>
      ctx.db.insert("notePositions", {
        principalId: bea.id,
        notebookId: journal,
        noteId: other,
        key: "k",
      }),
    );

    await removeAll(ada, journal, ada.notebookId, false);
    // Orders and positions are hidden at once and removed in batches.
    expect((await bea.as.query(api.arrangement.mine, {})).orders).toEqual([]);
    expect(
      (await t.run((ctx) => ctx.db.query("listOrders").collect())).length,
    ).toBeGreaterThan(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => ({
      members: await ctx.db
        .query("notebookMembers")
        .withIndex("by_notebook_and_principal", (q) =>
          q.eq("notebookId", journal),
        )
        .collect(),
      invitations: (await ctx.db.query("invitations").collect()).filter(
        (i) => i.notebookId === journal,
      ),
      orders: await ctx.db.query("listOrders").collect(),
      positions: await ctx.db.query("notePositions").collect(),
      tombstones: await ctx.db
        .query("noteTombstones")
        .withIndex("by_notebook_and_seq", (q) => q.eq("notebookId", journal))
        .collect(),
      sequence: await ctx.db
        .query("notebookSequences")
        .withIndex("by_notebook", (q) => q.eq("notebookId", journal))
        .unique(),
    }));
    expect(left.members).toEqual([]);
    expect(left.invitations).toHaveLength(2);
    const [open] = left.invitations.filter((i) => i.acceptedAt === undefined);
    const [accepted] = left.invitations.filter(
      (i) => i.acceptedAt !== undefined,
    );
    expect(open!.revokedAt).toEqual(expect.any(Number));
    expect(accepted!.revokedAt).toBeUndefined();
    expect(left.orders.map((o) => o.list)).toEqual(["all"]);
    expect(left.positions).toEqual([]);
    expect(left.tombstones).toEqual([]);
    expect(left.sequence).toBeNull();
    // The open invitation now says it was revoked; others are untouched.
    expect(invited.kind).toBe("invited");
    if (invited.kind === "invited")
      expect(
        (await t.query(api.invitations.preview, { token: invited.token }))!
          .status,
      ).toBe("revoked");
    expect(elsewhere.kind).toBe("invited");
    expect(
      (await ada.as.query(api.invitations.pending, {})).map((i) => i.email),
    ).toEqual(["other@example.com"]);
    expect(
      (await bea.as.query(api.library.notebooks, {})).map((n) => n.id),
    ).toEqual([bea.notebookId]);
    expect((await bea.as.query(api.arrangement.mine, {})).orders).toEqual([]);
  });

  test("a large notebook is deleted over several bounded calls", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const journal = await notebook(ada, "Journal");
    const ids: Id<"notes">[] = [];
    for (let i = 0; i < 120; i++)
      ids.push(await note(ada, journal, `Note ${i}`));
    // Rows a long-lived notebook gathers: feed entries of notes that left
    // it, and many people's sort orders and positions.
    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i++) {
        await ctx.db.insert("noteTombstones", {
          notebookId: journal,
          noteId: ids[i % ids.length]!,
          seq: 0,
        });
        await ctx.db.insert("listOrders", {
          principalId: ada.id,
          list: journal,
          order: "alpha",
        });
        await ctx.db.insert("notePositions", {
          principalId: ada.id,
          notebookId: journal,
          noteId: ids[i % ids.length]!,
          key: "V",
        });
      }
    });
    const first = await ada.as.mutation(api.notebooks.remove, {
      notebookId: journal,
      destinationId: ada.notebookId,
      trash: true,
    });
    expect(first).toEqual({ done: false, notes: 50 });
    // Part way, the notebook and its remaining notes are intact.
    const counts = await t.run(async (ctx) => {
      const notes = await ctx.db.query("notes").collect();
      return {
        journal: notes.filter((n) => n.notebookId === journal).length,
        trashed: notes.filter(
          (n) => n.notebookId === ada.notebookId && n.lifecycle === "trashed",
        ).length,
      };
    });
    expect(counts).toEqual({ journal: 70, trashed: 50 });
    expect(await row(t, journal)).not.toBeNull();

    const rest = await removeAll(ada, journal, ada.notebookId, true);
    expect(rest).toEqual([
      { done: false, notes: 50 },
      { done: false, notes: 20 },
      // 400 of the 570 feed entries, then the rest.
      { done: false, notes: 0 },
      { done: true, notes: 0 },
    ]);
    for (const id of ids)
      expect(await row(t, id)).toMatchObject({
        notebookId: ada.notebookId,
        lifecycle: "trashed",
      });
    expect((await ada.as.query(api.arrangement.mine, {})).orders).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => ({
      orders: await ctx.db.query("listOrders").collect(),
      positions: await ctx.db.query("notePositions").collect(),
      tombstones: (await ctx.db.query("noteTombstones").collect()).filter(
        (row) => row.notebookId === journal,
      ),
    }));
    expect(left).toEqual({ orders: [], positions: [], tombstones: [] });
  });

  test("repeating is harmless, and notes added part way are moved too", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const journal = await notebook(ada, "Journal");
    await share(t, journal, bea.id, "edit", ada.id);
    const first = await note(ada, journal, "First");
    const args = {
      notebookId: journal,
      destinationId: ada.notebookId,
      trash: false,
    };
    expect(await ada.as.mutation(api.notebooks.remove, args)).toEqual({
      done: false,
      notes: 1,
    });
    // A member adds a note before the memberships go.
    const late = await note(bea, journal, "Late");
    const calls = await removeAll(ada, journal, ada.notebookId, false);
    expect(calls[0]).toEqual({ done: false, notes: 1 });
    expect(calls.at(-1)!.done).toBe(true);
    for (const id of [first, late]) {
      const moved = (await row(t, id))!;
      expect(moved.notebookId).toBe(ada.notebookId);
      // Notes belong to the notebook owner, whoever created them.
      expect(moved.ownerId).toBe(ada.id);
    }
    expect(await ada.as.mutation(api.notebooks.remove, args)).toEqual({
      done: true,
      notes: 0,
    });
    // A person's note for the deleted notebook goes to their own default
    // notebook (review round 1), not into anything of Ada's.
    const tooLate = await note(bea, journal, "Too late");
    expect(await row(t, tooLate)).toMatchObject({
      notebookId: bea.notebookId,
      ownerId: bea.id,
    });
  });

  test("the preview is only for the owner and a valid destination", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const journal = await notebook(ada, "Journal");
    await share(t, journal, bea.id, "edit", ada.id);
    const args = {
      notebookId: journal,
      destinationId: ada.notebookId,
      trash: false,
    };
    // An empty notebook takes nothing from anyone.
    expect(await ada.as.query(api.notebooks.deletePreview, args)).toEqual({
      destinationId: ada.notebookId,
      trash: false,
      lost: [],
      destinationShared: false,
      complete: true,
    });
    await note(ada, journal, "Plans");
    expect(await ada.as.query(api.notebooks.deletePreview, args)).toEqual({
      destinationId: ada.notebookId,
      trash: false,
      lost: [{ principalId: bea.id, name: "Bea" }],
      destinationShared: false,
      complete: true,
    });
    expect(await bea.as.query(api.notebooks.deletePreview, args)).toBeNull();
    expect(
      await ada.as.query(api.notebooks.deletePreview, {
        ...args,
        destinationId: journal,
      }),
    ).toBeNull();
    expect(
      await ada.as.query(api.notebooks.deletePreview, {
        ...args,
        destinationId: bea.notebookId,
      }),
    ).toBeNull();
    await expect(t.query(api.notebooks.deletePreview, args)).rejects.toThrow(
      /Sign in/,
    );
  });
});

/** A stored document whose single paragraph is `text`. */
function docOf(text: string) {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

describe("review round 1 regressions", () => {
  test("F1/F3: a person's note for a deleted notebook goes to their default notebook", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const journal = await notebook(ada, "Journal");
    await removeAll(ada, journal, ada.notebookId, false);
    // A draft typed in Journal on another device, created after it went.
    const created = await ada.as.mutation(api.notes.create, {
      notebookId: journal,
      clientKey: "local-offline",
      doc: docOf("Written offline"),
    });
    expect(created.replayed).toBe(false);
    expect(await row(t, created.noteId)).toMatchObject({
      notebookId: ada.notebookId,
      ownerId: ada.id,
      creatorId: ada.id,
    });
    // Its retry is the same note, not another.
    expect(
      await ada.as.mutation(api.notes.create, {
        notebookId: journal,
        clientKey: "local-offline",
        doc: docOf("Written offline"),
      }),
    ).toEqual({ noteId: created.noteId, revision: 0, replayed: true });
    // The Markdown path behaves the same for people.
    const markdown = await ada.as.mutation(api.notes.createFromMarkdown, {
      notebookId: journal,
      markdown: "From Markdown",
    });
    expect(markdown.notebookId).toBe(ada.notebookId);
  });

  test("F1/F3: a person whose membership was removed or made read-only keeps their note in their own default", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const team = await notebook(ada, "Team");
    const member = await share(t, team, bea.id, "edit", ada.id);
    await t.run((ctx) => ctx.db.delete(member));
    const removed = await bea.as.mutation(api.notes.create, {
      notebookId: team,
      clientKey: "local-removed",
      doc: docOf("Typed before removal"),
    });
    expect(await row(t, removed.noteId)).toMatchObject({
      notebookId: bea.notebookId,
      ownerId: bea.id,
    });
    await share(t, team, bea.id, "read", ada.id);
    const readOnly = await bea.as.mutation(api.notes.create, {
      notebookId: team,
      clientKey: "local-read",
      doc: docOf("Typed before becoming a reader"),
    });
    expect(await row(t, readOnly.noteId)).toMatchObject({
      notebookId: bea.notebookId,
      ownerId: bea.id,
    });
    // Nothing reached Ada's notebook.
    const inTeam = await t.run((ctx) =>
      ctx.db
        .query("notes")
        .withIndex("by_notebook_and_seq", (q) => q.eq("notebookId", team))
        .collect(),
    );
    expect(inTeam).toEqual([]);
  });

  test("F1/F3: agents, replays and conflict copies of unreadable notes are refused as before", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const claude = await agent(t, ada.id, ["share", "move", "delete"]);
    const journal = await notebook(ada, "Journal");
    await share(t, journal, claude.id, "edit", ada.id);
    await share(t, ada.notebookId, claude.id, "read", ada.id);
    await removeAll(ada, journal, ada.notebookId, false);
    // Agents: a missing notebook and a read-only one still refuse.
    await expect(
      claude.as.mutation(api.notes.create, {
        notebookId: journal,
        clientKey: "agent-missing",
        doc: docOf("Agent note"),
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      claude.as.mutation(api.notes.createFromMarkdown, {
        notebookId: ada.notebookId,
        markdown: "Agent note",
      }),
    ).rejects.toThrow(/edit access/);
    // A replay of a note the person can no longer open reveals nothing.
    const team = await notebook(ada, "Team");
    const member = await share(t, team, bea.id, "edit", ada.id);
    await bea.as.mutation(api.notes.create, {
      notebookId: team,
      clientKey: "local-team",
      doc: docOf("Team note"),
    });
    await t.run((ctx) => ctx.db.delete(member));
    await expect(
      bea.as.mutation(api.notes.create, {
        notebookId: team,
        clientKey: "local-team",
        doc: docOf("Team note"),
      }),
    ).rejects.toThrow(/not found/);
    // A conflict copy of a note the person cannot open is still refused,
    // whatever its notebook.
    const source = await note(ada, team, "Source");
    await expect(
      bea.as.mutation(api.notes.create, {
        notebookId: team,
        clientKey: "local-copy",
        doc: docOf("Copy"),
        sourceNoteId: source,
      }),
    ).rejects.toThrow(/not found/);
  });

  test("F1/F3: a conflict copy of a note the person can open goes to their default when its notebook went", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const shared = await notebook(ada, "Shared");
    await share(t, shared, bea.id, "edit", ada.id);
    const open = await note(ada, shared, "Open source");
    await ada.as.mutation(api.sharing.setNoteMember, {
      noteId: open,
      principalId: bea.id,
      role: "edit",
    });
    await removeAll(ada, shared, ada.notebookId, false);
    const copy = await bea.as.mutation(api.notes.create, {
      notebookId: shared,
      clientKey: "local-open-copy",
      doc: docOf("Open source, my version"),
      sourceNoteId: open,
    });
    expect((await row(t, copy.noteId))!.notebookId).toBe(bea.notebookId);
  });

  test("F2: large notes are deleted in calls bounded by bytes, within transaction limits", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const journal = await notebook(ada, "Journal");
    const body = "word ".repeat(80_000); // 400,000 characters
    const ids: Id<"notes">[] = [];
    for (let i = 0; i < 24; i++)
      ids.push(await note(ada, journal, `Large ${i}\n\n${body}`));
    const calls = await removeAll(ada, journal, ada.notebookId, true);
    const filed = calls.filter((call) => call.notes > 0);
    expect(filed.reduce((sum, call) => sum + call.notes, 0)).toBe(24);
    // Each note costs about 1.2 MB of reads in Trash: several calls.
    expect(filed.length).toBeGreaterThan(3);
    expect(Math.max(...filed.map((call) => call.notes))).toBeLessThan(10);
    for (const id of ids)
      expect(await row(t, id)).toMatchObject({
        notebookId: ada.notebookId,
        lifecycle: "trashed",
      });
  });

  test("F2: one note of the largest size always fits in a call", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const journal = await notebook(ada, "Journal");
    // The largest document the app accepts, in ASCII.
    const largest = await ada.as.mutation(api.notes.create, {
      notebookId: journal,
      clientKey: "largest",
      doc: docOf("x".repeat(699_000)),
    });
    // A search text at Convex's 1 MiB document limit, in multi-byte text,
    // more than any accepted note can produce.
    const widest = await note(ada, journal, "Widest");
    await t.run(async (ctx) => {
      const text = await ctx.db
        .query("noteText")
        .withIndex("by_note", (q) => q.eq("noteId", widest))
        .unique();
      await ctx.db.patch(text!._id, { text: "€".repeat(349_000) });
    });
    const calls = await removeAll(ada, journal, ada.notebookId, true);
    expect(calls.filter((call) => call.notes > 0).length).toBeGreaterThan(0);
    for (const id of [largest.noteId, widest])
      expect(await row(t, id)).toMatchObject({
        notebookId: ada.notebookId,
        lifecycle: "trashed",
      });
  });

  test("F4: the preview counts notes already in Trash, per-note grants and incomplete scans", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const cy = await human(t, "Cy");
    const journal = await notebook(ada, "Journal");
    for (const person of [bea, cy]) {
      await share(t, journal, person.id, "edit", ada.id);
      await share(t, ada.notebookId, person.id, "edit", ada.id);
    }
    const binned = await note(ada, journal, "Binned");
    await ada.as.mutation(api.notes.trash, { noteId: binned });
    // Cy keeps the binned note through an explicit grant; Bea does not.
    await ada.as.mutation(api.sharing.setNoteMember, {
      noteId: binned,
      principalId: cy.id,
      role: "read",
    });
    const args = {
      notebookId: journal,
      destinationId: ada.notebookId,
      trash: false,
    };
    expect(
      (await ada.as.query(api.notebooks.deletePreview, args))!.lost,
    ).toEqual([{ principalId: bea.id, name: "Bea" }]);
    await removeAll(ada, journal, ada.notebookId, false);
    expect(await bea.as.query(api.notes.get, { noteId: binned })).toBeNull();
    expect(
      (await cy.as.query(api.notes.get, { noteId: binned }))!.summary.role,
    ).toBe("read");

    // A "No access" override means nothing to lose; a restricted note too.
    const diary = await notebook(ada, "Diary");
    await share(t, diary, bea.id, "read", ada.id);
    const hidden = await note(ada, diary, "Hidden");
    await ada.as.mutation(api.sharing.setNoteMember, {
      noteId: hidden,
      principalId: bea.id,
      role: "none",
    });
    const privateNote = await note(ada, diary, "Private");
    await ada.as.mutation(api.sharing.setNoteRestricted, {
      noteId: privateNote,
      restricted: true,
    });
    const archive = await notebook(ada, "Archive");
    expect(
      await ada.as.query(api.notebooks.deletePreview, {
        notebookId: diary,
        destinationId: archive,
        trash: false,
      }),
    ).toMatchObject({ lost: [], complete: true });

    // More members than the preview examines: it says so.
    const crowd = await notebook(ada, "Crowd");
    await note(ada, crowd, "Notice");
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        const principalId = await ctx.db.insert("principals", {
          kind: "human",
          name: `Member ${i}`,
          createdAt: Date.now(),
        });
        await ctx.db.insert("notebookMembers", {
          notebookId: crowd,
          principalId,
          role: "read",
          grantedBy: ada.id,
          createdAt: Date.now(),
        });
      }
    });
    const crowded = (await ada.as.query(api.notebooks.deletePreview, {
      notebookId: crowd,
      destinationId: archive,
      trash: false,
    }))!;
    expect(crowded.complete).toBe(false);
    expect(crowded.lost).toHaveLength(200);
  });
});
