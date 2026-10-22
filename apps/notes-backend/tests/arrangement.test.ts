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

function setup() {
  const t = convexTest(schema, modules);
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
      noteId: first,
      pinned: true,
    });
    // Pinning again changes nothing.
    await ada.as.mutation(api.arrangement.setPin, {
      noteId: first,
      pinned: true,
    });
    expect((await ada.as.query(api.arrangement.mine, {})).pins).toEqual([
      { noteId: first, pinnedAt: expect.any(Number) },
    ]);
    expect((await bea.as.query(api.arrangement.mine, {})).pins).toEqual([]);
    // A reader may pin a note for themselves.
    await bea.as.mutation(api.arrangement.setPin, {
      noteId: first,
      pinned: true,
    });
    expect((await bea.as.query(api.arrangement.mine, {})).pins).toHaveLength(1);
    await ada.as.mutation(api.arrangement.setPin, {
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
      bea.as.mutation(api.arrangement.setPin, { noteId: first, pinned: true }),
    ).rejects.toThrow(/not found/);
    await expect(
      bea.as.mutation(api.arrangement.setOrder, {
        list: ada.notebookId,
        order: "alpha",
      }),
    ).rejects.toThrow(/not found/);
    const member = await share(t, ada.notebookId, bea.id, "read", ada.id);
    await bea.as.mutation(api.arrangement.setPin, {
      noteId: first,
      pinned: true,
    });
    await bea.as.mutation(api.arrangement.setOrder, {
      list: ada.notebookId,
      order: "custom",
    });
    await bea.as.mutation(api.arrangement.setPositions, {
      notebookId: ada.notebookId,
      entries: [{ noteId: first, key: "V" }],
    });
    await t.run((ctx) => ctx.db.delete(member));
    expect(await bea.as.query(api.arrangement.mine, {})).toEqual({
      pins: [],
      orders: [],
      positions: [],
    });
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
      agent.mutation(api.arrangement.setPin, { noteId: first, pinned: true }),
    ).rejects.toThrow(/Only people/);
    await expect(t.query(api.arrangement.mine, {})).rejects.toThrow(/Sign in/);
  });

  test("sort orders: All Notes and notebooks, custom only for notebooks", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    await ada.as.mutation(api.arrangement.setOrder, {
      list: "all",
      order: "alpha",
    });
    await ada.as.mutation(api.arrangement.setOrder, {
      list: "all",
      order: "created",
    });
    await ada.as.mutation(api.arrangement.setOrder, {
      list: ada.notebookId,
      order: "custom",
    });
    await expect(
      ada.as.mutation(api.arrangement.setOrder, {
        list: "all",
        order: "custom",
      }),
    ).rejects.toThrow(/per notebook/);
    await expect(
      ada.as.mutation(api.arrangement.setOrder, {
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
      notebookId: ada.notebookId,
      entries: [
        { noteId: first, key: "V" },
        { noteId: second, key: "k" },
      ],
    });
    // Rewriting a position replaces it.
    await ada.as.mutation(api.arrangement.setPositions, {
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
        notebookId: ada.notebookId,
        entries: [{ noteId: first, key: "no spaces" }],
      }),
    ).rejects.toThrow(/Invalid position/);
    await expect(
      ada.as.mutation(api.arrangement.setPositions, {
        notebookId: archive,
        entries: [{ noteId: first, key: "V" }],
      }),
    ).rejects.toThrow(/another notebook/);
    await expect(
      ada.as.mutation(api.arrangement.setPositions, {
        notebookId: ada.notebookId,
        entries: Array.from({ length: 501 }, () => ({
          noteId: first,
          key: "V",
        })),
      }),
    ).rejects.toThrow(/At most 500/);
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
        noteId: second,
        pinned: true,
      });
      await person.as.mutation(api.arrangement.setPositions, {
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
    const leftover = await t.run((ctx) =>
      ctx.db
        .query("notePositions")
        .withIndex("by_note", (q) => q.eq("noteId", first))
        .collect(),
    );
    expect(leftover).toEqual([]);
    await ada.as.mutation(api.notes.trash, { noteId: second });
    await ada.as.mutation(api.lifecycle.deleteForever, { noteId: second });
    const rows = await t.run(async (ctx) => ({
      pins: await ctx.db
        .query("pins")
        .withIndex("by_note", (q) => q.eq("noteId", second))
        .collect(),
      positions: await ctx.db
        .query("notePositions")
        .withIndex("by_note", (q) => q.eq("noteId", second))
        .collect(),
    }));
    expect(rows).toEqual({ pins: [], positions: [] });
  });
});
