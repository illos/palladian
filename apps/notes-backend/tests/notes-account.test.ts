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

async function created(t: T, person: Person, clientKey: string) {
  return t.run((ctx) =>
    ctx.db
      .query("notes")
      .withIndex("by_creator_and_client_key", (q) =>
        q.eq("creatorId", person.id).eq("clientKey", clientKey),
      )
      .unique(),
  );
}

const doc = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Copy" }] },
    { type: "paragraph", content: [{ type: "text", text: "Old text." }] },
  ],
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("notes.create account precondition (History review round 6, R6-1)", () => {
  test("a creation naming the caller's account is accepted", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const result = await ada.as.mutation(api.notes.create, {
      clientKey: "copy-same",
      doc,
      account: ada.account,
    });
    expect(result.replayed).toBe(false);
    expect(await created(t, ada, "copy-same")).not.toBeNull();
  });

  test("a creation naming another account is refused and creates nothing", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    // Ada's copy of her note, sent after the device switched to Bea.
    const { noteId } = await ada.as.mutation(api.notes.createFromMarkdown, {
      markdown: "Recipe\n\nFirst line.",
    });
    await share(t, ada.notebookId, bea.id, "edit", ada.id);
    await expect(
      bea.as.mutation(api.notes.create, {
        clientKey: "copy-crossed",
        doc,
        sourceNoteId: noteId,
        account: ada.account,
      }),
    ).rejects.toThrow(/another account/);
    expect(await created(t, bea, "copy-crossed")).toBeNull();
    expect(await created(t, ada, "copy-crossed")).toBeNull();
  });

  test("the account is checked before a retried key is replayed", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const bea = await human(t, "Bea");
    await bea.as.mutation(api.notes.create, { clientKey: "copy-key", doc });
    await expect(
      bea.as.mutation(api.notes.create, {
        clientKey: "copy-key",
        doc,
        account: ada.account,
      }),
    ).rejects.toThrow(/another account/);
  });

  test("a creation without an account works as before", async () => {
    const t = setup();
    const ada = await human(t, "Ada");
    const first = await ada.as.mutation(api.notes.create, {
      clientKey: "copy-plain",
      doc,
    });
    const again = await ada.as.mutation(api.notes.create, {
      clientKey: "copy-plain",
      doc,
    });
    expect(again).toEqual({ ...first, replayed: true });
  });
});
