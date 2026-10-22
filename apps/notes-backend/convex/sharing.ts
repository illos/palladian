import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
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
  noteRole,
  notebookRole,
  requirePrincipal,
  type Principal,
} from "./access";
import { touchNote } from "./documents";
import { noteOverride, role } from "./schema";

const memberView = v.object({
  principalId: v.id("principals"),
  name: v.string(),
  kind: v.union(v.literal("human"), v.literal("agent")),
  email: v.union(v.string(), v.null()),
  controllerName: v.union(v.string(), v.null()),
  role: v.union(
    v.literal("owner"),
    v.literal("edit"),
    v.literal("read"),
    v.literal("none"),
  ),
});

async function describe(
  ctx: QueryCtx,
  principal: Doc<"principals">,
  showEmail: boolean,
) {
  const controller = principal.controllerId
    ? await ctx.db.get(principal.controllerId)
    : null;
  return {
    principalId: principal._id,
    name: principal.name,
    kind: principal.kind,
    email: showEmail ? (principal.email ?? null) : null,
    controllerName: controller?.name ?? null,
  };
}

/** Who can access a notebook. Visible to anyone with access; emails to owners only. */
export const notebookMembers = query({
  args: { notebookId: v.id("notebooks") },
  returns: v.union(v.null(), v.array(memberView)),
  handler: async (ctx, args) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook || !(await notebookRole(ctx, principal, notebook)))
      return null;
    const showEmail = hasOwnerAuthority(principal, notebook.ownerId, "share");
    const owner = await ctx.db.get(notebook.ownerId);
    const result: Infer<typeof memberView>[] = owner
      ? [{ ...(await describe(ctx, owner, showEmail)), role: "owner" as const }]
      : [];
    const members = await ctx.db
      .query("notebookMembers")
      .withIndex("by_notebook_and_principal", (q) =>
        q.eq("notebookId", notebook._id),
      )
      .take(200);
    for (const member of members) {
      const row = await ctx.db.get(member.principalId);
      if (row)
        result.push({
          ...(await describe(ctx, row, showEmail)),
          role: member.role,
        });
    }
    return result;
  },
});

/** A note's sharing state: restriction plus explicit grants. */
export const noteAccess = query({
  args: { noteId: v.id("notes") },
  returns: v.union(
    v.null(),
    v.object({
      restricted: v.boolean(),
      canShare: v.boolean(),
      grants: v.array(memberView),
    }),
  ),
  handler: async (ctx, args) => {
    const principal = await getPrincipal(ctx);
    if (!principal) return null;
    const note = await ctx.db.get(args.noteId);
    if (!note || !(await noteRole(ctx, principal, note))) return null;
    const canShare = hasOwnerAuthority(principal, note.ownerId, "share");
    const grants = await ctx.db
      .query("noteMembers")
      .withIndex("by_note_and_principal", (q) => q.eq("noteId", note._id))
      .take(200);
    const views = [];
    for (const grant of grants) {
      const row = await ctx.db.get(grant.principalId);
      if (row)
        views.push({
          ...(await describe(ctx, row, canShare)),
          role: grant.role,
        });
    }
    return { restricted: note.restricted, canShare, grants: views };
  },
});

async function requireShareable(
  ctx: QueryCtx,
  actor: Principal,
  ownerId: Id<"principals">,
  principalId: Id<"principals">,
) {
  if (!hasOwnerAuthority(actor, ownerId, "share"))
    fail(
      "denied",
      "Only the owner, or an agent they delegated, can change sharing.",
    );
  if (principalId === ownerId) fail("invalid", "The owner always has access.");
  if (actor.kind === "agent" && principalId === actor._id)
    fail("denied", "Agents cannot change their own access.");
  const target = await ctx.db.get(principalId);
  if (!target || target.disabledAt !== undefined)
    fail("not_found", "That person or agent does not exist.");
  return target;
}

export const setNotebookMember = mutation({
  args: {
    notebookId: v.id("notebooks"),
    principalId: v.id("principals"),
    role: v.union(role, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const notebook = await ctx.db.get(args.notebookId);
    if (!notebook) fail("not_found", "Notebook not found.");
    await requireShareable(ctx, actor, notebook.ownerId, args.principalId);
    const existing = await ctx.db
      .query("notebookMembers")
      .withIndex("by_notebook_and_principal", (q) =>
        q.eq("notebookId", notebook._id).eq("principalId", args.principalId),
      )
      .unique();
    if (args.role === null) {
      if (existing) await ctx.db.delete(existing._id);
    } else if (existing) await ctx.db.patch(existing._id, { role: args.role });
    else
      await ctx.db.insert("notebookMembers", {
        notebookId: notebook._id,
        principalId: args.principalId,
        role: args.role,
        grantedBy: actor._id,
        createdAt: Date.now(),
      });
    return null;
  },
});

export const setNoteRestricted = mutation({
  args: { noteId: v.id("notes"), restricted: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const note = await ctx.db.get(args.noteId);
    if (!note || !(await noteRole(ctx, actor, note)))
      fail("not_found", "Note not found.");
    if (!hasOwnerAuthority(actor, note.ownerId, "share"))
      fail(
        "denied",
        "Only the owner, or an agent they delegated, can change sharing.",
      );
    await changeRestriction(ctx, note, args.restricted);
    return null;
  },
});

/**
 * Set a note's private override: notebook members lose access unless granted
 * explicitly. Callers have checked sharing authority.
 */
export async function changeRestriction(
  ctx: MutationCtx,
  note: Doc<"notes">,
  restricted: boolean,
) {
  if (note.restricted === restricted) return;
  await ctx.db.patch(note._id, { restricted });
  await touchNote(ctx, (await ctx.db.get(note._id))!);
}

export const setNoteMember = mutation({
  args: {
    noteId: v.id("notes"),
    principalId: v.id("principals"),
    role: v.union(noteOverride, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const note = await ctx.db.get(args.noteId);
    if (!note || !(await noteRole(ctx, actor, note)))
      fail("not_found", "Note not found.");
    await requireShareable(ctx, actor, note.ownerId, args.principalId);
    const existing = await ctx.db
      .query("noteMembers")
      .withIndex("by_note_and_principal", (q) =>
        q.eq("noteId", note._id).eq("principalId", args.principalId),
      )
      .unique();
    if (args.role === null) {
      if (existing) await ctx.db.delete(existing._id);
    } else if (existing) await ctx.db.patch(existing._id, { role: args.role });
    else
      await ctx.db.insert("noteMembers", {
        noteId: note._id,
        principalId: args.principalId,
        role: args.role,
        grantedBy: actor._id,
        createdAt: Date.now(),
      });
    await touchNote(ctx, note);
    return null;
  },
});

/** People and agents the caller can pick in sharing controls. */
export const candidates = query({
  args: {},
  returns: v.array(
    v.object({
      principalId: v.id("principals"),
      name: v.string(),
      kind: v.union(v.literal("human"), v.literal("agent")),
      email: v.union(v.string(), v.null()),
      controllerName: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const principal = await getPrincipal(ctx);
    if (!principal || principal.kind !== "human") return [];
    const seen = new Map<Id<"principals">, Doc<"principals">>();
    const agents = await ctx.db
      .query("principals")
      .withIndex("by_controller", (q) => q.eq("controllerId", principal._id))
      .take(100);
    for (const agent of agents)
      if (!agent.disabledAt) seen.set(agent._id, agent);
    const owned = await ctx.db
      .query("notebooks")
      .withIndex("by_owner", (q) => q.eq("ownerId", principal._id))
      .take(200);
    for (const notebook of owned) {
      const members = await ctx.db
        .query("notebookMembers")
        .withIndex("by_notebook_and_principal", (q) =>
          q.eq("notebookId", notebook._id),
        )
        .take(100);
      for (const member of members) {
        if (seen.has(member.principalId)) continue;
        const row = await ctx.db.get(member.principalId);
        if (row && !row.disabledAt) seen.set(row._id, row);
      }
    }
    const invited = await ctx.db
      .query("invitations")
      .withIndex("by_inviter", (q) => q.eq("invitedBy", principal._id))
      .take(200);
    for (const invitation of invited) {
      if (!invitation.acceptedBy || seen.has(invitation.acceptedBy)) continue;
      const row = await ctx.db.get(invitation.acceptedBy);
      if (row && !row.disabledAt) seen.set(row._id, row);
    }
    const result = [];
    for (const row of seen.values())
      result.push(await describe(ctx, row, true));
    return result.sort((a, b) => a.name.localeCompare(b.name));
  },
});
