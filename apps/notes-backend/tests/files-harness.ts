/// <reference types="vite/client" />
// Shared fixtures for the file tests (files.test.ts, files-review.test.ts).
import { markdownToDoc } from "@palladian/notes-core";
import { convexTest } from "convex-test";
import { expect, vi } from "vitest";
import { api, components } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import authSchema from "../convex/betterAuth/schema";
import schema from "../convex/schema";

export const AGENT_ISSUER = "https://agent.test";
process.env.AGENT_JWT_ISSUER = AGENT_ISSUER;
export const DAY = 86_400_000;
const modules = import.meta.glob([
  "../convex/**/*.ts",
  "!../convex/betterAuth/**",
]);
const authModules = import.meta.glob("../convex/betterAuth/**/*.ts");

/**
 * A test deployment that enforces Convex's transaction limits (convex-test
 * counts index ranges; `databaseQueries` can tighten that to leave room for
 * the `db.get` reads a real deployment also counts).
 */
export function setup(limits: true | { databaseQueries: number } = true) {
  const t = convexTest({ schema, modules, transactionLimits: limits });
  t.registerComponent("betterAuth", authSchema, authModules);
  return t;
}
export type T = ReturnType<typeof setup>;
export type As = ReturnType<T["withIdentity"]>;

export async function human(t: T, name: string) {
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

export async function agent(t: T, controllerId: Id<"principals">) {
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

export async function share(
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
export const service = (t: T) =>
  t.withIdentity({ issuer: AGENT_ISSUER, subject: "service:files" });

export async function sha256(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type Target = { noteId: Id<"notes"> } | { notebookId: Id<"notebooks"> };

export async function ticket(
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
export async function upload(
  t: T,
  as: As,
  target: Target,
  bytes = "png bytes",
) {
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

export function docJson(markdown: string) {
  return JSON.stringify(markdownToDoc(markdown).toJSON());
}

export async function createNote(
  as: As,
  markdown: string,
  key = crypto.randomUUID(),
) {
  const { noteId } = await as.mutation(api.notes.create, {
    clientKey: key,
    doc: docJson(markdown),
  });
  return noteId;
}

export async function replaceAll(
  as: As,
  noteId: Id<"notes">,
  markdown: string,
) {
  const content = (await as.query(api.notes.content, { noteId }))!;
  return await as.mutation(api.notes.edit, {
    noteId,
    expectedRevision: content.revision,
    edits: [{ type: "replace_all", markdown }],
  });
}

export const image = (id: string) => `![](attachment:${id})`;

export async function object(t: T, id: Id<"objects">) {
  return await t.run((ctx) => ctx.db.get(id));
}
export async function refs(t: T, id: Id<"objects">) {
  return await t.run((ctx) =>
    ctx.db
      .query("objectRefs")
      .withIndex("by_object_and_current", (q) => q.eq("objectId", id))
      .collect(),
  );
}
export async function deletions(t: T) {
  return (await t.run((ctx) => ctx.db.query("objectDeletions").collect())).map(
    (row) => row.key,
  );
}
export const settle = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
