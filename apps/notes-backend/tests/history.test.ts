/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, components } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";

const modules = import.meta.glob([
  "../convex/**/*.ts",
  "!../convex/betterAuth/**",
]);
const authModules = import.meta.glob("../convex/betterAuth/**/*.ts");

function setup() {
  const t = convexTest({ schema, modules, transactionLimits: false });
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
type Person = Awaited<ReturnType<typeof human>>;

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

/** A note with one edit after it was created: revision 0 can be restored. */
async function edited(person: Person) {
  const { noteId } = await person.as.mutation(api.notes.createFromMarkdown, {
    markdown: "Recipe\n\nFirst line.",
  });
  const { revision } = await person.as.mutation(api.notes.edit, {
    noteId,
    edits: [{ type: "append", markdown: "Second line." }],
  });
  return { noteId, revision };
}

async function restores(person: Person, noteId: Id<"notes">) {
  const { versions } = await person.as.query(api.history.list, { noteId });
  return versions.filter((version) => version.kind === "restore").length;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("history.restore account precondition (review round 4, R4-3)", () => {
  test("a restore naming the caller's account applies, and replays once", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const { noteId, revision } = await edited(ada);
    const request = {
      noteId,
      revision: 0,
      expectedRevision: revision,
      requestId: "restore-1",
      account: ada.account,
    };
    const first = await ada.as.mutation(api.history.restore, request);
    expect(first.replayed).toBe(false);
    // The same request again is answered from the receipt, not applied twice,
    // even after the note has moved on.
    await ada.as.mutation(api.notes.edit, {
      noteId,
      edits: [{ type: "append", markdown: "Later." }],
    });
    const again = await ada.as.mutation(api.history.restore, request);
    expect(again).toEqual({ revision: first.revision, replayed: true });
    expect(await restores(ada, noteId)).toBe(1);
  });

  test("a restore naming another account is refused and leaves no receipt", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const { noteId, revision } = await edited(ada);
    // Bea may edit Ada's notebook, so only the precondition stands between
    // Ada's queued request and Bea's sign-in.
    await share(t, ada.notebookId, bea.id, "edit", ada.id);
    const request = {
      noteId,
      revision: 0,
      expectedRevision: revision,
      requestId: "restore-ada",
      account: ada.account,
    };
    await expect(bea.as.mutation(api.history.restore, request)).rejects.toThrow(
      /another account/,
    );
    expect(await restores(ada, noteId)).toBe(0);
    // Nothing was recorded under Bea; Ada's own request still applies once.
    const mine = await ada.as.mutation(api.history.restore, request);
    expect(mine.replayed).toBe(false);
    expect(await restores(ada, noteId)).toBe(1);
  });

  test("the account is checked before the receipt", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    const { noteId, revision } = await edited(ada);
    await share(t, ada.notebookId, bea.id, "edit", ada.id);
    const request = {
      noteId,
      revision: 0,
      expectedRevision: revision,
      requestId: "restore-shared-id",
    };
    await bea.as.mutation(api.history.restore, {
      ...request,
      account: bea.account,
    });
    await expect(
      bea.as.mutation(api.history.restore, {
        ...request,
        account: ada.account,
      }),
    ).rejects.toThrow(/another account/);
  });

  test("callers that name no account (agents) are unaffected", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const { noteId, revision } = await edited(ada);
    const result = await ada.as.mutation(api.history.restore, {
      noteId,
      revision: 0,
      expectedRevision: revision,
      requestId: "restore-agent-style",
    });
    expect(result.replayed).toBe(false);
  });
});
