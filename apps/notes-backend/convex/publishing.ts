import { docToMarkdown, parseStoredDoc } from "@palladian/notes-core";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  fail,
  getPrincipal,
  hasOwnerAuthority,
  loadNote,
  noteRole,
  requirePrincipal,
} from "./access";
import { getContent } from "./documents";
import { newToken } from "./invitations";

async function activeLink(ctx: QueryCtx | MutationCtx, note: Doc<"notes">) {
  const links = await ctx.db
    .query("publicLinks")
    .withIndex("by_note", (q) => q.eq("noteId", note._id))
    .take(50);
  return links.find((link) => link.revokedAt === undefined) ?? null;
}

export const status = query({
  args: { noteId: v.id("notes") },
  returns: v.union(
    v.null(),
    v.object({
      canPublish: v.boolean(),
      canReplace: v.boolean(),
      token: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    const note = await ctx.db.get(args.noteId);
    if (!note || !(await noteRole(ctx, principal, note))) return null;
    const link = await activeLink(ctx, note);
    return {
      canPublish: hasOwnerAuthority(principal, note.ownerId, "publish"),
      canReplace: principal._id === note.ownerId,
      token: link?.token ?? null,
    };
  },
});

/** Publish a read-only public link. Later accepted edits appear without republishing. */
export const publish = mutation({
  args: { noteId: v.id("notes") },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const { note } = await loadNote(ctx, actor, args.noteId, "read");
    if (!hasOwnerAuthority(actor, note.ownerId, "publish"))
      fail(
        "denied",
        "Only the owner, or an agent they delegated, can publish notes.",
      );
    const existing = await activeLink(ctx, note);
    if (existing) return { token: existing.token };
    const token = newToken();
    await ctx.db.insert("publicLinks", {
      noteId: note._id,
      token,
      createdBy: actor._id,
      createdAt: Date.now(),
    });
    return { token };
  },
});

export const unpublish = mutation({
  args: { noteId: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const { note } = await loadNote(ctx, actor, args.noteId, "read");
    if (!hasOwnerAuthority(actor, note.ownerId, "publish"))
      fail(
        "denied",
        "Only the owner, or an agent they delegated, can change publishing.",
      );
    const link = await activeLink(ctx, note);
    if (link) await ctx.db.patch(link._id, { revokedAt: Date.now() });
    return null;
  },
});

/** Replace the public URL; the old one stays invalid. Owner only. */
export const replace = mutation({
  args: { noteId: v.id("notes") },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const { note } = await loadNote(ctx, actor, args.noteId, "read");
    if (actor._id !== note.ownerId)
      fail("denied", "Only the owner can replace a public link.");
    const link = await activeLink(ctx, note);
    if (link) await ctx.db.patch(link._id, { revokedAt: Date.now() });
    const token = newToken();
    await ctx.db.insert("publicLinks", {
      noteId: note._id,
      token,
      createdBy: actor._id,
      createdAt: Date.now(),
    });
    return { token };
  },
});

/** Public read of a published note's latest accepted content. Hidden while in Trash. */
export const read = query({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({ title: v.string(), markdown: v.string(), editedAt: v.number() }),
  ),
  handler: async (ctx, args) => {
    if (args.token.length < 20 || args.token.length > 100) return null;
    const link = await ctx.db
      .query("publicLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!link || link.revokedAt !== undefined) return null;
    const note = await ctx.db.get(link.noteId);
    if (!note || note.lifecycle !== "active") return null;
    const content = await getContent(ctx, note._id);
    return {
      title: note.title,
      markdown: docToMarkdown(parseStoredDoc(content.doc)),
      editedAt: note.editedAt,
    };
  },
});
