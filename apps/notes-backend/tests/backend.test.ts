/// <reference types="vite/client" />
import betterAuthTest from "@convex-dev/better-auth/test";
import { markdownToDoc, notesSchema } from "@palladian/notes-core";
import { convexTest } from "convex-test";
import { Transform } from "prosemirror-transform";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const AGENT_ISSUER = "https://agent.test";
process.env.AGENT_JWT_ISSUER = AGENT_ISSUER;
const modules = import.meta.glob("../convex/**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  betterAuthTest.register(t);
  return t;
}
type T = ReturnType<typeof setup>;

async function human(
  t: T,
  name: string,
  email = name.toLowerCase() + "@example.com",
) {
  const now = Date.now();
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

async function agent(
  t: T,
  controllerId: Id<"principals">,
  delegations: ("share" | "move" | "delete" | "publish")[] = [],
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
    return { id: agentId, connectionId };
  });
  return {
    ...made,
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

function docJson(markdown: string) {
  return JSON.stringify(markdownToDoc(markdown).toJSON());
}

async function stepsFor(doc: string, edit: (tr: Transform) => void) {
  const tr = new Transform(notesSchema.nodeFromJSON(JSON.parse(doc)));
  edit(tr);
  return tr.steps.map((s) => JSON.stringify(s.toJSON()));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("notes and collaboration", () => {
  test("owner pushes steps; stale revisions are told to rebase", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const { noteId } = await owner.as.mutation(api.notes.create, {
      clientKey: "draft-1",
      doc: docJson("Hello\n\nworld"),
    });
    const content = (await owner.as.query(api.notes.content, { noteId }))!;
    expect(content.revision).toBe(0);
    const steps = await stepsFor(content.doc, (tr) =>
      tr.insert(6, notesSchema.text("!")),
    );
    const accepted = await owner.as.mutation(api.notes.push, {
      noteId,
      revision: 0,
      steps,
      clientId: "c1",
    });
    expect(accepted).toEqual({ status: "accepted", revision: 1 });
    const behind = await owner.as.mutation(api.notes.push, {
      noteId,
      revision: 0,
      steps,
      clientId: "c2",
    });
    expect(behind).toEqual({ status: "behind", revision: 1 });
    const feed = await owner.as.query(api.notes.steps, { noteId, after: 0 });
    expect(feed.steps).toHaveLength(1);
    expect(feed.steps[0]!.clientId).toBe("c1");
    // Summary projections refresh shortly after edits.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const meta = await owner.as.query(api.notes.get, { noteId });
    expect(meta!.summary.title).toBe("Hello!");
  });

  test("creation is idempotent per client key", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const a = await owner.as.mutation(api.notes.create, {
      clientKey: "k",
      doc: docJson("One"),
    });
    const b = await owner.as.mutation(api.notes.create, {
      clientKey: "k",
      doc: docJson("One"),
    });
    expect(b.noteId).toBe(a.noteId);
  });

  test("server repairs duplicate block IDs from concurrent splits", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const { noteId } = await owner.as.mutation(api.notes.create, {
      clientKey: "k",
      doc: docJson("Hello world"),
    });
    const content = (await owner.as.query(api.notes.content, { noteId }))!;
    // Splitting a paragraph copies its attributes, duplicating the ID.
    const steps = await stepsFor(content.doc, (tr) => tr.split(6));
    const result = await owner.as.mutation(api.notes.push, {
      noteId,
      revision: 0,
      steps,
      clientId: "c",
    });
    expect(result.status).toBe("accepted");
    expect(result.revision).toBe(2);
    const after = (await owner.as.query(api.notes.content, { noteId }))!;
    const doc = JSON.parse(after.doc) as {
      content: { attrs: { id: string } }[];
    };
    expect(new Set(doc.content.map((b) => b.attrs.id)).size).toBe(2);
    const feed = await owner.as.query(api.notes.steps, { noteId, after: 1 });
    expect(feed.steps[0]!.clientId).toBe("server");
  });

  test("invalid steps are rejected without changing the note", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const { noteId } = await owner.as.mutation(api.notes.create, {
      clientKey: "k",
      doc: docJson("Hi"),
    });
    await expect(
      owner.as.mutation(api.notes.push, {
        noteId,
        revision: 0,
        steps: [JSON.stringify({ stepType: "replace", from: 999, to: 1000 })],
        clientId: "c",
      }),
    ).rejects.toThrow();
    expect(
      (await owner.as.query(api.notes.content, { noteId }))!.revision,
    ).toBe(0);
  });
});

describe("authorization", () => {
  test("strangers cannot see notes; readers cannot edit or browse history", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const reader = await human(t, "Bo");
    const stranger = await human(t, "Cy");
    const { noteId } = await owner.as.mutation(api.notes.create, {
      clientKey: "k",
      doc: docJson("Secret"),
    });
    expect(await stranger.as.query(api.notes.get, { noteId })).toBeNull();
    expect(await stranger.as.query(api.notes.content, { noteId })).toBeNull();
    await expect(
      stranger.as.query(api.notes.readMarkdown, { noteId, format: "markdown" }),
    ).rejects.toThrow(/not found/i);
    expect(
      await stranger.as.query(api.library.search, { query: "Secret" }),
    ).toEqual([]);

    await share(t, owner.notebookId, reader.id, "read", owner.id);
    expect((await reader.as.query(api.notes.content, { noteId }))!.role).toBe(
      "read",
    );
    await expect(
      reader.as.mutation(api.notes.push, {
        noteId,
        revision: 0,
        steps: [],
        clientId: "c",
      }),
    ).rejects.toThrow(/edit access/);
    await expect(
      reader.as.query(api.notes.steps, { noteId, after: 0 }),
    ).rejects.toThrow(/edit access/);
    await expect(reader.as.query(api.history.list, { noteId })).rejects.toThrow(
      /edit access/,
    );
    await expect(
      reader.as.mutation(api.notes.trash, { noteId }),
    ).rejects.toThrow(/edit access/);
  });

  test("restricted notes and explicit overrides", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const member = await human(t, "Bo");
    const outsider = await human(t, "Cy");
    await share(t, owner.notebookId, member.id, "edit", owner.id);
    const { noteId } = await owner.as.mutation(api.notes.create, {
      clientKey: "k",
      doc: docJson("Plan"),
    });
    expect(await member.as.query(api.notes.get, { noteId })).not.toBeNull();

    await owner.as.mutation(api.sharing.setNoteRestricted, {
      noteId,
      restricted: true,
    });
    expect(await member.as.query(api.notes.get, { noteId })).toBeNull();
    const feed = await member.as.query(api.library.changes, {
      notebookId: owner.notebookId,
      after: 0,
    });
    expect(feed.access && feed.removed).toContain(noteId);

    await owner.as.mutation(api.sharing.setNoteMember, {
      noteId,
      principalId: member.id,
      role: "read",
    });
    expect(
      (await member.as.query(api.notes.get, { noteId }))!.summary.role,
    ).toBe("read");

    // A note can be shared on its own from a private notebook.
    await owner.as.mutation(api.sharing.setNoteMember, {
      noteId,
      principalId: outsider.id,
      role: "edit",
    });
    const shared = await outsider.as.query(api.library.shared, {});
    expect(shared.map((n) => n.id)).toEqual([noteId]);
    expect(
      (await outsider.as.query(api.notes.get, { noteId }))!.notebook,
    ).toBeNull();

    // An explicit "none" denies even a notebook member when the note is not restricted.
    await owner.as.mutation(api.sharing.setNoteRestricted, {
      noteId,
      restricted: false,
    });
    await owner.as.mutation(api.sharing.setNoteMember, {
      noteId,
      principalId: member.id,
      role: "none",
    });
    expect(await member.as.query(api.notes.get, { noteId })).toBeNull();
  });

  test("only owners change sharing", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const editor = await human(t, "Bo");
    const other = await human(t, "Cy");
    await share(t, owner.notebookId, editor.id, "edit", owner.id);
    await expect(
      editor.as.mutation(api.sharing.setNotebookMember, {
        notebookId: owner.notebookId,
        principalId: other.id,
        role: "read",
      }),
    ).rejects.toThrow(/owner/);
  });
});

describe("agents", () => {
  test("authentication alone grants nothing; sharing does", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const claude = await agent(t, owner.id);
    await expect(
      claude.as.mutation(api.notes.createFromMarkdown, { markdown: "# Hi" }),
    ).rejects.toThrow(/No notebook/);
    expect(await claude.as.query(api.library.notebooks, {})).toEqual([]);

    await share(t, owner.notebookId, claude.id, "edit", owner.id);
    const created = await claude.as.mutation(api.notes.createFromMarkdown, {
      markdown: "# Meeting\n\nNotes from today.",
      requestId: "req-1",
    });
    expect(created.title).toBe("Meeting");
    const again = await claude.as.mutation(api.notes.createFromMarkdown, {
      markdown: "# Meeting\n\nNotes from today.",
      requestId: "req-1",
    });
    expect(again).toMatchObject({ noteId: created.noteId, replayed: true });
    await expect(
      claude.as.mutation(api.notes.createFromMarkdown, {
        markdown: "different",
        requestId: "req-1",
      }),
    ).rejects.toThrow(/request_id/);

    // The note belongs to the notebook owner, created by the agent.
    const meta = (await owner.as.query(api.notes.get, {
      noteId: created.noteId,
    }))!;
    expect(meta.ownerId).toBe(owner.id);
    expect(meta.creatorId).toBe(claude.id);

    const edited = await claude.as.mutation(api.notes.edit, {
      noteId: created.noteId,
      edits: [{ type: "replace_text", old_text: "today", new_text: "Tuesday" }],
      expectedRevision: 0,
    });
    expect(edited.revision).toBeGreaterThan(0);
    const read = await owner.as.query(api.notes.readMarkdown, {
      noteId: created.noteId,
      format: "markdown",
    });
    expect(read.markdown).toBe("# Meeting\n\nNotes from Tuesday.");
  });

  test("revoking a connection takes effect immediately", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const claude = await agent(t, owner.id);
    await share(t, owner.notebookId, claude.id, "read", owner.id);
    expect(await claude.as.query(api.library.notebooks, {})).toHaveLength(1);
    await owner.as.mutation(api.connections.revoke, {
      connectionId: claude.connectionId,
    });
    expect(await claude.as.query(api.library.notebooks, {})).toEqual([]);
    await expect(claude.as.query(api.library.recent, {})).rejects.toThrow(
      /Sign in/,
    );
  });

  test("a forged connection claim does not authenticate", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const claude = await agent(t, owner.id);
    const other = await agent(t, owner.id);
    await share(t, owner.notebookId, claude.id, "read", owner.id);
    const forged = t.withIdentity({
      issuer: AGENT_ISSUER,
      subject: claude.id,
      cid: other.connectionId,
    });
    expect(await forged.query(api.library.notebooks, {})).toEqual([]);
  });

  test("delegation lets an agent share its owner's notebooks, never its own access", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const friend = await human(t, "Bo");
    const plain = await agent(t, owner.id);
    const trusted = await agent(t, owner.id, ["share"]);
    await share(t, owner.notebookId, plain.id, "edit", owner.id);
    await share(t, owner.notebookId, trusted.id, "edit", owner.id);
    await expect(
      plain.as.mutation(api.sharing.setNotebookMember, {
        notebookId: owner.notebookId,
        principalId: friend.id,
        role: "read",
      }),
    ).rejects.toThrow(/owner/);
    await trusted.as.mutation(api.sharing.setNotebookMember, {
      notebookId: owner.notebookId,
      principalId: friend.id,
      role: "read",
    });
    const visible = await friend.as.query(api.library.notebooks, {});
    expect(visible.find((n) => n.id === owner.notebookId)?.role).toBe("read");
    await expect(
      trusted.as.mutation(api.sharing.setNotebookMember, {
        notebookId: owner.notebookId,
        principalId: trusted.id,
        role: null,
      }),
    ).rejects.toThrow(/own access/);
  });

  test("OAuth approval codes are single-use and bound to the request", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const approval = await owner.as.mutation(api.connections.approve, {
      requestKey: "request-key-0123456789",
      clientId: "https://claude.ai/oauth/client",
      clientName: "Claude",
      redirectHost: "claude.ai",
      agentName: "Claude",
      notebooks: [{ notebookId: owner.notebookId, role: "edit" }],
    });
    await expect(
      t.mutation(api.connections.redeem, {
        code: approval.code,
        requestKey: "another-request-key-000",
      }),
    ).rejects.toThrow(/no longer valid/);
    const redeemed = await t.mutation(api.connections.redeem, {
      code: approval.code,
      requestKey: "request-key-0123456789",
    });
    expect(redeemed.agentId).toBe(approval.agentId);
    await expect(
      t.mutation(api.connections.redeem, {
        code: approval.code,
        requestKey: "request-key-0123456789",
      }),
    ).rejects.toThrow(/no longer valid/);
    const connected = t.withIdentity({
      issuer: AGENT_ISSUER,
      subject: redeemed.agentId,
      cid: redeemed.connectionId,
    });
    expect(await connected.query(api.library.notebooks, {})).toHaveLength(1);
  });
});

describe("library, search and history", () => {
  test("search is scoped to accessible notes", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const other = await human(t, "Bo");
    await owner.as.mutation(api.notes.create, {
      clientKey: "a",
      doc: docJson("Apple pie recipe"),
    });
    await other.as.mutation(api.notes.create, {
      clientKey: "b",
      doc: docJson("Apple tart secret"),
    });
    const mine = await owner.as.query(api.library.search, { query: "apple" });
    expect(mine.map((r) => r.summary.title)).toEqual(["Apple pie recipe"]);
    expect(mine[0]!.excerpt).toContain("Apple");
  });

  test("library feed pages by cursor and reports trash", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const { noteId } = await owner.as.mutation(api.notes.create, {
      clientKey: "a",
      doc: docJson("One"),
    });
    const first = await owner.as.query(api.library.changes, {
      notebookId: owner.notebookId,
      after: 0,
    });
    if (!first.access) throw new Error("no access");
    expect(first.notes.map((n) => n.id)).toEqual([noteId]);
    const idle = await owner.as.query(api.library.changes, {
      notebookId: owner.notebookId,
      after: first.cursor,
    });
    expect(idle.access && idle.notes).toEqual([]);
    await owner.as.mutation(api.notes.trash, { noteId });
    const next = await owner.as.query(api.library.changes, {
      notebookId: owner.notebookId,
      after: first.cursor,
    });
    expect(next.access && next.notes[0]!.trashed).toBe(true);
    expect(await owner.as.query(api.library.search, { query: "One" })).toEqual(
      [],
    );
    await expect(
      owner.as.mutation(api.notes.edit, {
        noteId,
        edits: [{ type: "append", markdown: "x" }],
      }),
    ).rejects.toThrow(/Trash/);
  });

  test("history reads past revisions and restore appends", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const { noteId } = await owner.as.mutation(api.notes.createFromMarkdown, {
      markdown: "Draft one",
    });
    await owner.as.mutation(api.notes.edit, {
      noteId,
      edits: [{ type: "replace_text", old_text: "one", new_text: "two" }],
    });
    const current = await owner.as.query(api.notes.readMarkdown, {
      noteId,
      format: "markdown",
    });
    expect(current.markdown).toBe("Draft two");
    const past = await owner.as.query(api.history.read, {
      noteId,
      revision: 0,
    });
    expect(past.markdown).toBe("Draft one");
    await expect(
      owner.as.mutation(api.history.restore, {
        noteId,
        revision: 0,
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/changed/);
    const restored = await owner.as.mutation(api.history.restore, {
      noteId,
      revision: 0,
      expectedRevision: current.revision,
    });
    expect(restored.revision).toBeGreaterThan(current.revision);
    expect(
      (
        await owner.as.query(api.notes.readMarkdown, {
          noteId,
          format: "markdown",
        })
      ).markdown,
    ).toBe("Draft one");
    const versions = await owner.as.query(api.history.list, { noteId });
    expect(versions.versions.map((v) => v.kind)).toEqual([
      "restore",
      "edit",
      "create",
    ]);
  });
});

describe("invitations", () => {
  test("existing accounts are granted; new emails get a single-use link", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const friend = await human(t, "Bo");
    const granted = await owner.as.mutation(api.invitations.create, {
      email: "BO@example.com ",
      notebookId: owner.notebookId,
      role: "read",
    });
    expect(granted).toEqual({ kind: "granted", principalId: friend.id });
    const invited = await owner.as.mutation(api.invitations.create, {
      email: "new@example.com",
      notebookId: owner.notebookId,
      role: "edit",
    });
    if (invited.kind !== "invited") throw new Error("expected invitation");
    const preview = await t.query(api.invitations.preview, {
      token: invited.token,
    });
    expect(preview).toMatchObject({
      email: "new@example.com",
      target: "Notes",
      status: "open",
    });
    await expect(
      friend.as.mutation(api.invitations.acceptExisting, {
        token: invited.token,
      }),
    ).rejects.toThrow(/different email/);
  });

  test("account creation claims the invitation once", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const invited = await owner.as.mutation(api.invitations.create, {
      email: "new@example.com",
      notebookId: owner.notebookId,
      role: "edit",
    });
    if (invited.kind !== "invited") throw new Error("expected invitation");
    const { hashToken } = await import("../convex/invitations");
    const tokenHash = await hashToken(invited.token);
    await t.mutation(internal.invitations.claim, {
      tokenHash,
      now: Date.now(),
    });
    await expect(
      t.mutation(internal.invitations.claim, { tokenHash, now: Date.now() }),
    ).rejects.toThrow(/being accepted/);
    await t.mutation(internal.invitations.complete, {
      tokenHash,
      authUserId: "auth-user",
      name: "Nia",
    });
    await expect(
      t.mutation(internal.invitations.claim, { tokenHash, now: Date.now() }),
    ).rejects.toThrow(/no longer valid/);
    const principal = await t.run((ctx) =>
      ctx.db
        .query("principals")
        .withIndex("by_email", (q) => q.eq("email", "new@example.com"))
        .unique(),
    );
    expect(principal?.defaultNotebookId).toBeTruthy();
    const membership = await t.run((ctx) =>
      ctx.db
        .query("notebookMembers")
        .withIndex("by_notebook_and_principal", (q) =>
          q
            .eq("notebookId", owner.notebookId)
            .eq("principalId", principal!._id),
        )
        .unique(),
    );
    expect(membership?.role).toBe("edit");
  });
});

describe("trash, moves and publishing", () => {
  test("permanent deletion needs owner authority and removes history", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const editor = await human(t, "Bo");
    await share(t, owner.notebookId, editor.id, "edit", owner.id);
    const { noteId } = await owner.as.mutation(api.notes.createFromMarkdown, {
      markdown: "Doomed",
    });
    await owner.as.mutation(api.notes.edit, {
      noteId,
      edits: [{ type: "append", markdown: "more" }],
    });
    await expect(
      owner.as.mutation(api.lifecycle.deleteForever, { noteId }),
    ).rejects.toThrow(/Trash/);
    await editor.as.mutation(api.notes.trash, { noteId });
    await expect(
      editor.as.mutation(api.lifecycle.deleteForever, { noteId }),
    ).rejects.toThrow(/owner/);
    await owner.as.mutation(api.lifecycle.deleteForever, { noteId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await owner.as.query(api.notes.get, { noteId })).toBeNull();
    const leftovers = await t.run(async (ctx) => ({
      steps: (
        await ctx.db
          .query("noteSteps")
          .withIndex("by_note_and_revision", (q) => q.eq("noteId", noteId))
          .collect()
      ).length,
      versions: (
        await ctx.db
          .query("noteVersions")
          .withIndex("by_note_and_revision", (q) => q.eq("noteId", noteId))
          .collect()
      ).length,
      content: await ctx.db
        .query("noteContent")
        .withIndex("by_note", (q) => q.eq("noteId", noteId))
        .unique(),
    }));
    expect(leftovers).toEqual({ steps: 0, versions: 0, content: null });
    const feed = await editor.as.query(api.library.changes, {
      notebookId: owner.notebookId,
      after: 0,
    });
    expect(feed.access && feed.removed).toContain(noteId);
  });

  test("expired Trash is purged by the owner's current retention", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const keep = await owner.as.mutation(api.notes.createFromMarkdown, {
      markdown: "Recent",
    });
    const old = await owner.as.mutation(api.notes.createFromMarkdown, {
      markdown: "Old",
    });
    await owner.as.mutation(api.notes.trash, { noteId: keep.noteId });
    await owner.as.mutation(api.notes.trash, { noteId: old.noteId });
    await t.run((ctx) =>
      ctx.db.patch(old.noteId, { trashedAt: Date.now() - 10 * 86_400_000 }),
    );
    await owner.as.mutation(api.lifecycle.setTrashRetention, { days: 7 });
    await t.mutation(internal.lifecycle.purgeExpired, {});
    expect(
      await owner.as.query(api.notes.get, { noteId: old.noteId }),
    ).toBeNull();
    expect(
      await owner.as.query(api.notes.get, { noteId: keep.noteId }),
    ).not.toBeNull();
    await expect(
      owner.as.mutation(api.lifecycle.setTrashRetention, { days: 3 }),
    ).rejects.toThrow(/Choose/);
  });

  test("moves keep the note and warn about lost access", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const member = await human(t, "Bo");
    const other = await human(t, "Cy");
    await share(t, owner.notebookId, member.id, "read", owner.id);
    const archive = await owner.as.mutation(api.notebooks.create, {
      name: "Archive",
    });
    const { noteId } = await owner.as.mutation(api.notes.createFromMarkdown, {
      markdown: "Move me",
    });
    const preview = await owner.as.query(api.lifecycle.movePreview, {
      noteId,
      notebookId: archive,
    });
    expect(preview.map((p) => p.name)).toEqual(["Bo"]);
    await owner.as.mutation(api.lifecycle.move, {
      noteId,
      notebookId: archive,
    });
    expect(
      (await owner.as.query(api.notes.get, { noteId }))!.summary.notebookId,
    ).toBe(archive);
    expect(await member.as.query(api.notes.get, { noteId })).toBeNull();
    await expect(
      owner.as.mutation(api.lifecycle.move, {
        noteId,
        notebookId: other.notebookId,
      }),
    ).rejects.toThrow(/same owner/);
  });

  test("public links show live content, hide in Trash and die on replacement", async () => {
    const t = setup();
    const owner = await human(t, "Ada");
    const plain = await agent(t, owner.id);
    await share(t, owner.notebookId, plain.id, "edit", owner.id);
    const { noteId } = await owner.as.mutation(api.notes.createFromMarkdown, {
      markdown: "# Public\n\nHello",
    });
    await expect(
      plain.as.mutation(api.publishing.publish, { noteId }),
    ).rejects.toThrow(/publish/);
    const { token } = await owner.as.mutation(api.publishing.publish, {
      noteId,
    });
    expect((await t.query(api.publishing.read, { token }))!.markdown).toBe(
      "# Public\n\nHello",
    );
    await owner.as.mutation(api.notes.edit, {
      noteId,
      edits: [{ type: "append", markdown: "Later" }],
    });
    expect((await t.query(api.publishing.read, { token }))!.markdown).toContain(
      "Later",
    );
    await owner.as.mutation(api.notes.trash, { noteId });
    expect(await t.query(api.publishing.read, { token })).toBeNull();
    await owner.as.mutation(api.notes.restore, { noteId });
    expect(await t.query(api.publishing.read, { token })).not.toBeNull();
    const replaced = await owner.as.mutation(api.publishing.replace, {
      noteId,
    });
    expect(await t.query(api.publishing.read, { token })).toBeNull();
    expect(
      await t.query(api.publishing.read, { token: replaced.token }),
    ).not.toBeNull();
  });
});
