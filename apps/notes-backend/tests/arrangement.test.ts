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

/** A person with a live session and a default notebook. */
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
    /** The app's account ID (the Better Auth user ID). */
    account: made.userId,
    as: t.withIdentity({
      subject: made.userId,
      sessionId: made.sessionId,
      issuer: "https://site.test",
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

type Person = Awaited<ReturnType<typeof human>>;
async function note(person: Person, markdown: string) {
  return (await person.as.mutation(api.notes.createFromMarkdown, { markdown }))
    .noteId;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("arrangement", () => {
  test("pins are personal: members pin shared notes for themselves only", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const first = await note(ada, "First");
    await share(t, ada.notebookId, bea.id, "read", ada.id);
    await ada.as.mutation(api.arrangement.setPin, {
      account: ada.account,
      noteId: first,
      pinned: true,
    });
    // Pinning again changes nothing.
    await ada.as.mutation(api.arrangement.setPin, {
      account: ada.account,
      noteId: first,
      pinned: true,
    });
    expect((await ada.as.query(api.arrangement.mine, {})).pins).toEqual([
      { noteId: first, pinnedAt: expect.any(Number) },
    ]);
    expect((await bea.as.query(api.arrangement.mine, {})).pins).toEqual([]);
    // A reader may pin a note for themselves.
    await bea.as.mutation(api.arrangement.setPin, {
      account: bea.account,
      noteId: first,
      pinned: true,
    });
    expect((await bea.as.query(api.arrangement.mine, {})).pins).toHaveLength(1);
    await ada.as.mutation(api.arrangement.setPin, {
      account: ada.account,
      noteId: first,
      pinned: false,
    });
    expect((await ada.as.query(api.arrangement.mine, {})).pins).toEqual([]);
    expect((await bea.as.query(api.arrangement.mine, {})).pins).toHaveLength(1);
  });

  test("nothing is arranged without access, and losing access hides it", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const first = await note(ada, "First");
    await expect(
      bea.as.mutation(api.arrangement.setPin, {
        account: bea.account,
        noteId: first,
        pinned: true,
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      bea.as.mutation(api.arrangement.setOrder, {
        account: bea.account,
        list: ada.notebookId,
        order: "alpha",
      }),
    ).rejects.toThrow(/not found/);
    const member = await share(t, ada.notebookId, bea.id, "read", ada.id);
    await bea.as.mutation(api.arrangement.setPin, {
      account: bea.account,
      noteId: first,
      pinned: true,
    });
    await bea.as.mutation(api.arrangement.setOrder, {
      account: bea.account,
      list: ada.notebookId,
      order: "custom",
    });
    await bea.as.mutation(api.arrangement.setPositions, {
      account: bea.account,
      notebookId: ada.notebookId,
      entries: [{ noteId: first, key: "V" }],
    });
    await t.run((ctx) => ctx.db.delete(member));
    expect(await bea.as.query(api.arrangement.mine, {})).toEqual({
      version: 3,
      pins: [],
      orders: [],
      positions: [],
    });
    // Unpinning needs no access: it only removes the person's own row.
    await bea.as.mutation(api.arrangement.setPin, {
      account: bea.account,
      noteId: first,
      pinned: false,
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pins")
          .withIndex("by_principal_and_note", (q) =>
            q.eq("principalId", bea.id),
          )
          .collect(),
      ),
    ).toEqual([]);
  });

  test("agents and signed-out callers are refused", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const first = await note(ada, "First");
    const made = await t.run(async (ctx) => {
      const agentId = await ctx.db.insert("principals", {
        kind: "agent",
        name: "Claude",
        controllerId: ada.id,
        createdAt: Date.now(),
      });
      const connectionId = await ctx.db.insert("connections", {
        agentId,
        controllerId: ada.id,
        clientId: "client",
        clientName: "Claude",
        redirectHost: "claude.ai",
        createdAt: Date.now(),
      });
      return { agentId, connectionId };
    });
    const agent = t.withIdentity({
      issuer: AGENT_ISSUER,
      subject: made.agentId,
      cid: made.connectionId,
    });
    await expect(agent.query(api.arrangement.mine, {})).rejects.toThrow(
      /Only people/,
    );
    await expect(
      agent.mutation(api.arrangement.setPin, {
        account: "agent",
        noteId: first,
        pinned: true,
      }),
    ).rejects.toThrow(/Only people/);
    await expect(t.query(api.arrangement.mine, {})).rejects.toThrow(/Sign in/);
  });

  test("sort orders: All Notes and notebooks, custom only for notebooks", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    await ada.as.mutation(api.arrangement.setOrder, {
      account: ada.account,
      list: "all",
      order: "alpha",
    });
    await ada.as.mutation(api.arrangement.setOrder, {
      account: ada.account,
      list: "all",
      order: "created",
    });
    await ada.as.mutation(api.arrangement.setOrder, {
      account: ada.account,
      list: ada.notebookId,
      order: "custom",
    });
    await expect(
      ada.as.mutation(api.arrangement.setOrder, {
        account: ada.account,
        list: "all",
        order: "custom",
      }),
    ).rejects.toThrow(/per notebook/);
    await expect(
      ada.as.mutation(api.arrangement.setOrder, {
        account: ada.account,
        list: "not-a-notebook",
        order: "alpha",
      }),
    ).rejects.toThrow(/not found/);
    expect(
      (await ada.as.query(api.arrangement.mine, {})).orders.sort((a, b) =>
        a.list.localeCompare(b.list),
      ),
    ).toEqual(
      [
        { list: "all", order: "created" },
        { list: ada.notebookId, order: "custom" },
      ].sort((a, b) => a.list.localeCompare(b.list)),
    );
  });

  test("positions are validated and kept per notebook", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const first = await note(ada, "First");
    const second = await note(ada, "Second");
    const archive = await ada.as.mutation(api.notebooks.create, {
      name: "Archive",
    });
    await ada.as.mutation(api.arrangement.setPositions, {
      account: ada.account,
      notebookId: ada.notebookId,
      entries: [
        { noteId: first, key: "V" },
        { noteId: second, key: "k" },
      ],
    });
    // Rewriting a position replaces it.
    await ada.as.mutation(api.arrangement.setPositions, {
      account: ada.account,
      notebookId: ada.notebookId,
      entries: [{ noteId: second, key: "M" }],
    });
    expect(
      (await ada.as.query(api.arrangement.mine, {})).positions.sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    ).toEqual([
      { notebookId: ada.notebookId, noteId: second, key: "M" },
      { notebookId: ada.notebookId, noteId: first, key: "V" },
    ]);
    await expect(
      ada.as.mutation(api.arrangement.setPositions, {
        account: ada.account,
        notebookId: ada.notebookId,
        entries: [{ noteId: first, key: "no spaces" }],
      }),
    ).rejects.toThrow(/Invalid position/);
    await expect(
      ada.as.mutation(api.arrangement.setPositions, {
        account: ada.account,
        notebookId: archive,
        entries: [{ noteId: first, key: "V" }],
      }),
    ).rejects.toThrow(/another notebook/);
    await expect(
      ada.as.mutation(api.arrangement.setPositions, {
        account: ada.account,
        notebookId: ada.notebookId,
        entries: Array.from({ length: 101 }, () => ({
          noteId: first,
          key: "V",
        })),
      }),
    ).rejects.toThrow(/At most 100/);
    // One position per note in a write.
    await expect(
      ada.as.mutation(api.arrangement.setPositions, {
        account: ada.account,
        notebookId: ada.notebookId,
        entries: [
          { noteId: first, key: "V" },
          { noteId: first, key: "k" },
        ],
      }),
    ).rejects.toThrow(/one position/);
    // Keys never end in 0, as the app generates them.
    await expect(
      ada.as.mutation(api.arrangement.setPositions, {
        account: ada.account,
        notebookId: ada.notebookId,
        entries: [{ noteId: first, key: "V0" }],
      }),
    ).rejects.toThrow(/Invalid position/);
  });

  test("moving a note drops its positions; deleting it forever drops pins and positions", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    await share(t, ada.notebookId, bea.id, "edit", ada.id);
    const first = await note(ada, "First");
    const second = await note(ada, "Second");
    const archive = await ada.as.mutation(api.notebooks.create, {
      name: "Archive",
    });
    for (const person of [ada, bea]) {
      await person.as.mutation(api.arrangement.setPin, {
        account: person.account,
        noteId: second,
        pinned: true,
      });
      await person.as.mutation(api.arrangement.setPositions, {
        account: person.account,
        notebookId: ada.notebookId,
        entries: [
          { noteId: first, key: "V" },
          { noteId: second, key: "k" },
        ],
      });
    }
    await ada.as.mutation(api.lifecycle.move, {
      noteId: first,
      notebookId: archive,
    });
    // Reads leave the old positions out at once.
    expect(
      (await ada.as.query(api.arrangement.mine, {})).positions.map(
        (p) => p.noteId,
      ),
    ).toEqual([second]);
    // A position in the new notebook, set before the cleanup runs, stays.
    await ada.as.mutation(api.arrangement.setPositions, {
      account: ada.account,
      notebookId: archive,
      entries: [{ noteId: first, key: "V" }],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const leftover = await t.run((ctx) =>
      ctx.db
        .query("notePositions")
        .withIndex("by_note_and_notebook", (q) => q.eq("noteId", first))
        .collect(),
    );
    expect(leftover.map((p) => [p.principalId, p.notebookId])).toEqual([
      [ada.id, archive],
    ]);
    await ada.as.mutation(api.notes.trash, { noteId: second });
    await ada.as.mutation(api.lifecycle.deleteForever, { noteId: second });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run(async (ctx) => ({
      pins: await ctx.db
        .query("pins")
        .withIndex("by_note", (q) => q.eq("noteId", second))
        .collect(),
      positions: await ctx.db
        .query("notePositions")
        .withIndex("by_note_and_notebook", (q) => q.eq("noteId", second))
        .collect(),
    }));
    expect(rows).toEqual({ pins: [], positions: [] });
  });

  test("positions are left out note by note: restricted, overridden, moved", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    await share(t, ada.notebookId, bea.id, "read", ada.id);
    const first = await note(ada, "First");
    const second = await note(ada, "Second");
    const third = await note(ada, "Third");
    await bea.as.mutation(api.arrangement.setPositions, {
      account: bea.account,
      notebookId: ada.notebookId,
      entries: [
        { noteId: first, key: "F" },
        { noteId: second, key: "V" },
        { noteId: third, key: "k" },
      ],
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(first, { restricted: true });
      await ctx.db.insert("noteMembers", {
        noteId: second,
        principalId: bea.id,
        role: "none",
        grantedBy: ada.id,
        createdAt: Date.now(),
      });
    });
    expect(
      (await bea.as.query(api.arrangement.mine, {})).positions.map(
        (p) => p.noteId,
      ),
    ).toEqual([third]);
  });

  test("cleanup runs in batches until every row is gone", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const first = await note(ada, "First");
    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i++) {
        const principalId = await ctx.db.insert("principals", {
          kind: "human",
          name: "Reader " + i,
          createdAt: Date.now(),
        });
        await ctx.db.insert("pins", {
          principalId,
          noteId: first,
          pinnedAt: i,
        });
        await ctx.db.insert("notePositions", {
          principalId,
          notebookId: ada.notebookId,
          noteId: first,
          key: "V",
        });
      }
    });
    await ada.as.mutation(api.notes.trash, { noteId: first });
    await ada.as.mutation(api.lifecycle.deleteForever, { noteId: first });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await t.run(async (ctx) => [
      ...(await ctx.db.query("pins").collect()),
      ...(await ctx.db.query("notePositions").collect()),
    ]);
    expect(rows).toEqual([]);
  });

  test("quotas reclaim rows the person can no longer use", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const member = await share(t, ada.notebookId, bea.id, "read", ada.id);
    const shared = await note(ada, "Shared");
    const own = await note(bea, "Own");
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++)
        await ctx.db.insert("pins", {
          principalId: bea.id,
          noteId: shared,
          pinnedAt: i,
        });
      for (let i = 0; i < 500; i++)
        await ctx.db.insert("notePositions", {
          principalId: bea.id,
          notebookId: ada.notebookId,
          noteId: shared,
          key: "V",
        });
      for (let i = 0; i < 100; i++)
        await ctx.db.insert("listOrders", {
          principalId: bea.id,
          list: "gone-" + i,
          order: "alpha",
        });
    });
    // While they are still usable, the quotas hold.
    await expect(
      bea.as.mutation(api.arrangement.setPin, {
        account: bea.account,
        noteId: own,
        pinned: true,
      }),
    ).rejects.toThrow(/up to 100/);
    await expect(
      bea.as.mutation(api.arrangement.setPositions, {
        account: bea.account,
        notebookId: bea.notebookId,
        entries: [{ noteId: own, key: "V" }],
      }),
    ).rejects.toThrow(/up to 500/);
    // Lists that are gone are reclaimed at once.
    await bea.as.mutation(api.arrangement.setOrder, {
      account: bea.account,
      list: bea.notebookId,
      order: "custom",
    });
    expect((await bea.as.query(api.arrangement.mine, {})).orders).toEqual([
      { list: bea.notebookId, order: "custom" },
    ]);
    // Once the notebook is no longer shared, the old rows are reclaimed.
    await t.run((ctx) => ctx.db.delete(member));
    await bea.as.mutation(api.arrangement.setPin, {
      account: bea.account,
      noteId: own,
      pinned: true,
    });
    await bea.as.mutation(api.arrangement.setPositions, {
      account: bea.account,
      notebookId: bea.notebookId,
      entries: [{ noteId: own, key: "V" }],
    });
    expect(await bea.as.query(api.arrangement.mine, {})).toEqual({
      version: expect.any(Number),
      pins: [{ noteId: own, pinnedAt: expect.any(Number) }],
      orders: [{ list: bea.notebookId, order: "custom" }],
      positions: [{ notebookId: bea.notebookId, noteId: own, key: "V" }],
    });
  });

  test("a note shared on its own does not keep its notebook's positions", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const member = await share(t, ada.notebookId, bea.id, "read", ada.id);
    const first = await note(ada, "First");
    await bea.as.mutation(api.arrangement.setPositions, {
      account: bea.account,
      notebookId: ada.notebookId,
      entries: [{ noteId: first, key: "V" }],
    });
    // Bea keeps the note through an explicit grant, but not the notebook.
    await t.run(async (ctx) => {
      await ctx.db.insert("noteMembers", {
        noteId: first,
        principalId: bea.id,
        role: "read",
        grantedBy: ada.id,
        createdAt: Date.now(),
      });
      await ctx.db.delete(member);
    });
    expect((await bea.as.query(api.arrangement.mine, {})).positions).toEqual(
      [],
    );
    // At the quota, such positions are reclaimed.
    const own = await note(bea, "Own");
    await t.run(async (ctx) => {
      for (let i = 0; i < 499; i++)
        await ctx.db.insert("notePositions", {
          principalId: bea.id,
          notebookId: ada.notebookId,
          noteId: first,
          key: "V",
        });
    });
    await bea.as.mutation(api.arrangement.setPositions, {
      account: bea.account,
      notebookId: bea.notebookId,
      entries: [{ noteId: own, key: "V" }],
    });
    const left = await t.run((ctx) =>
      ctx.db
        .query("notePositions")
        .withIndex("by_principal_and_notebook", (q) =>
          q.eq("principalId", bea.id),
        )
        .collect(),
    );
    expect(left.map((p) => p.noteId)).toEqual([own]);
  });

  test("a full arrangement across many shared notebooks reads within Convex limits", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    // 100 notebooks shared with Bea, five notes each: 500 positions on
    // distinct notes, 100 pins and 100 list orders, all on shared content.
    await t.run(async (ctx) => {
      const now = Date.now();
      let seq = 0;
      for (let b = 0; b < 100; b++) {
        const notebookId = await ctx.db.insert("notebooks", {
          ownerId: ada.id,
          name: "Shared " + b,
          description: "",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.insert("notebookMembers", {
          notebookId,
          principalId: bea.id,
          role: "read",
          grantedBy: ada.id,
          createdAt: now,
        });
        await ctx.db.insert("listOrders", {
          principalId: bea.id,
          list: notebookId,
          order: "custom",
        });
        for (let n = 0; n < 5; n++) {
          const noteId = await ctx.db.insert("notes", {
            notebookId,
            ownerId: ada.id,
            creatorId: ada.id,
            title: `Note ${b}.${n}`,
            preview: "",
            createdAt: now,
            editedAt: now,
            lifecycle: "active",
            restricted: false,
            seq: ++seq,
          });
          await ctx.db.insert("notePositions", {
            principalId: bea.id,
            notebookId,
            noteId,
            key: "V",
          });
          if (n === 0)
            await ctx.db.insert("pins", {
              principalId: bea.id,
              noteId,
              pinnedAt: now,
            });
        }
      }
    });
    const mine = await bea.as.query(api.arrangement.mine, {});
    expect(mine.pins).toHaveLength(100);
    expect(mine.orders).toHaveLength(100);
    expect(mine.positions).toHaveLength(500);
    // At the quota, a new position checks every row and is refused in time.
    const own = await note(bea, "Own");
    await expect(
      bea.as.mutation(api.arrangement.setPositions, {
        account: bea.account,
        notebookId: bea.notebookId,
        entries: [{ noteId: own, key: "V" }],
      }),
    ).rejects.toThrow(/up to 500/);
  });

  test("every write counts a version, which reads report", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const first = await note(ada, "First");
    expect((await ada.as.query(api.arrangement.mine, {})).version).toBe(0);
    expect(
      await ada.as.mutation(api.arrangement.setPin, {
        account: ada.account,
        noteId: first,
        pinned: true,
      }),
    ).toEqual({ version: 1 });
    expect(
      await ada.as.mutation(api.arrangement.setOrder, {
        account: ada.account,
        list: "all",
        order: "alpha",
      }),
    ).toEqual({ version: 2 });
    expect(
      await ada.as.mutation(api.arrangement.setPositions, {
        account: ada.account,
        notebookId: ada.notebookId,
        entries: [{ noteId: first, key: "V" }],
      }),
    ).toEqual({ version: 3 });
    expect((await ada.as.query(api.arrangement.mine, {})).version).toBe(3);
  });

  test("stored duplicates of a position read as one and are removed on write", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const first = await note(ada, "First");
    await t.run(async (ctx) => {
      for (const key of ["F", "M", "V", "k"])
        await ctx.db.insert("notePositions", {
          principalId: ada.id,
          notebookId: ada.notebookId,
          noteId: first,
          key,
        });
    });
    // Reads use the first row, the one a write updates.
    expect((await ada.as.query(api.arrangement.mine, {})).positions).toEqual([
      { notebookId: ada.notebookId, noteId: first, key: "F" },
    ]);
    await ada.as.mutation(api.arrangement.setPositions, {
      account: ada.account,
      notebookId: ada.notebookId,
      entries: [{ noteId: first, key: "z" }],
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("notePositions")
        .withIndex("by_principal_and_note", (q) =>
          q.eq("principalId", ada.id).eq("noteId", first),
        )
        .collect(),
    );
    expect(rows.map((r) => r.key)).toEqual(["z"]);
    expect((await ada.as.query(api.arrangement.mine, {})).positions).toEqual([
      { notebookId: ada.notebookId, noteId: first, key: "z" },
    ]);
  });

  test("a write made in another account is refused and changes nothing", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const own = await note(bea, "Own");
    // A change Ada made, arriving under Bea's sign-in.
    await expect(
      bea.as.mutation(api.arrangement.setOrder, {
        account: ada.account,
        list: "all",
        order: "alpha",
      }),
    ).rejects.toThrow(/another account/);
    await expect(
      bea.as.mutation(api.arrangement.setPin, {
        account: ada.account,
        noteId: own,
        pinned: true,
      }),
    ).rejects.toThrow(/another account/);
    await expect(
      bea.as.mutation(api.arrangement.setPositions, {
        account: ada.account,
        notebookId: bea.notebookId,
        entries: [{ noteId: own, key: "V" }],
      }),
    ).rejects.toThrow(/another account/);
    expect(await bea.as.query(api.arrangement.mine, {})).toEqual({
      version: 0,
      pins: [],
      orders: [],
      positions: [],
    });
  });

  test("reads and writes agree on which duplicate counts, across notebooks", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const first = await note(ada, "First");
    const archive = await ada.as.mutation(api.notebooks.create, {
      name: "Archive",
    });
    // The note lives in the notebook whose ID sorts later; its oldest row is
    // there. A newer, stale row sits in the notebook that sorts first, so a
    // read in notebook order would meet it first.
    const [earlier, later] =
      archive < ada.notebookId
        ? [archive, ada.notebookId]
        : [ada.notebookId, archive];
    if (later === archive)
      await ada.as.mutation(api.lifecycle.move, {
        noteId: first,
        notebookId: archive,
      });
    await t.run(async (ctx) => {
      await ctx.db.insert("notePositions", {
        principalId: ada.id,
        notebookId: later,
        noteId: first,
        key: "F",
      });
      await ctx.db.insert("notePositions", {
        principalId: ada.id,
        notebookId: earlier,
        noteId: first,
        key: "k",
      });
    });
    expect(earlier < later).toBe(true);
    expect((await ada.as.query(api.arrangement.mine, {})).positions).toEqual([
      { notebookId: later, noteId: first, key: "F" },
    ]);
  });

  test("up to 20 stored duplicates are removed; more are refused", async () => {
    const t = setup(true);
    const ada = await human(t, "Ada");
    const first = await note(ada, "First");
    const second = await note(ada, "Second");
    await t.run(async (ctx) => {
      for (let i = 0; i < 21; i++)
        await ctx.db.insert("notePositions", {
          principalId: ada.id,
          notebookId: ada.notebookId,
          noteId: first,
          key: "V",
        });
      for (let i = 0; i < 22; i++)
        await ctx.db.insert("notePositions", {
          principalId: ada.id,
          notebookId: ada.notebookId,
          noteId: second,
          key: "V",
        });
    });
    await ada.as.mutation(api.arrangement.setPositions, {
      account: ada.account,
      notebookId: ada.notebookId,
      entries: [{ noteId: first, key: "k" }],
    });
    await expect(
      ada.as.mutation(api.arrangement.setPositions, {
        account: ada.account,
        notebookId: ada.notebookId,
        entries: [{ noteId: second, key: "k" }],
      }),
    ).rejects.toThrow(/Too many stored positions/);
    const rows = await t.run((ctx) =>
      ctx.db
        .query("notePositions")
        .withIndex("by_principal_and_note", (q) =>
          q.eq("principalId", ada.id).eq("noteId", first),
        )
        .collect(),
    );
    expect(rows.map((r) => r.key)).toEqual(["k"]);
  });
});
