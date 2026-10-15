import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authComponent } from "./auth";
import { agentIssuer } from "./config";

/**
 * The single authorization layer. UI, MCP, search, history and sharing all
 * resolve the caller here and ask the same questions about access.
 */
export type Principal = Doc<"principals"> & {
  connectionId: Id<"connections"> | null;
};
export type Role = "owner" | "edit" | "read";
export type OwnerAction = "share" | "move" | "delete" | "publish";

const rank: Record<Role, number> = { read: 1, edit: 2, owner: 3 };
export function atLeast(role: Role | null, needed: Role): boolean {
  return role !== null && rank[role] >= rank[needed];
}

export type ErrorCode =
  | "unauthenticated"
  | "denied"
  | "not_found"
  | "invalid"
  | "conflict"
  | "trashed"
  | "too_large";
export function fail(code: ErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

type Ctx = QueryCtx | MutationCtx;

/** Resolve the authenticated caller. Identity never comes from arguments. */
export async function getPrincipal(ctx: Ctx): Promise<Principal | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  const issuer = agentIssuer();
  if (issuer && identity.issuer === issuer) {
    const connectionId =
      typeof identity.cid === "string"
        ? ctx.db.normalizeId("connections", identity.cid)
        : null;
    if (!connectionId) return null;
    const connection = await ctx.db.get(connectionId);
    if (!connection || connection.revokedAt !== undefined) return null;
    if (connection.agentId !== identity.subject) return null;
    const agent = await ctx.db.get(connection.agentId);
    if (!agent || agent.kind !== "agent" || agent.disabledAt !== undefined)
      return null;
    const controller = await ctx.db.get(connection.controllerId);
    if (!controller || controller.disabledAt !== undefined) return null;
    return { ...agent, connectionId };
  }
  // People: a live Better Auth session, not merely an unexpired token.
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) return null;
  const principal = await ctx.db
    .query("principals")
    .withIndex("by_auth_user", (q) => q.eq("authUserId", user._id))
    .unique();
  if (!principal || principal.disabledAt !== undefined) return null;
  return { ...principal, connectionId: null };
}

export async function requirePrincipal(ctx: Ctx): Promise<Principal> {
  const principal = await getPrincipal(ctx);
  if (!principal) fail("unauthenticated", "Sign in to continue.");
  return principal;
}

export async function requireHuman(ctx: Ctx): Promise<Principal> {
  const principal = await requirePrincipal(ctx);
  if (principal.kind !== "human")
    fail("denied", "Only people can perform this action.");
  return principal;
}

export async function notebookRole(
  ctx: Ctx,
  principal: Principal,
  notebook: Doc<"notebooks">,
): Promise<Role | null> {
  if (notebook.ownerId === principal._id) return "owner";
  const member = await ctx.db
    .query("notebookMembers")
    .withIndex("by_notebook_and_principal", (q) =>
      q.eq("notebookId", notebook._id).eq("principalId", principal._id),
    )
    .unique();
  return member?.role ?? null;
}

/**
 * Effective note access: owner; else an explicit note grant (which may deny);
 * else nothing when the note is restricted; else the notebook membership.
 */
export async function noteRole(
  ctx: Ctx,
  principal: Principal,
  note: Doc<"notes">,
): Promise<Role | null> {
  if (note.ownerId === principal._id) return "owner";
  const explicit = await ctx.db
    .query("noteMembers")
    .withIndex("by_note_and_principal", (q) =>
      q.eq("noteId", note._id).eq("principalId", principal._id),
    )
    .unique();
  if (explicit) return explicit.role === "none" ? null : explicit.role;
  if (note.restricted) return null;
  const member = await ctx.db
    .query("notebookMembers")
    .withIndex("by_notebook_and_principal", (q) =>
      q.eq("notebookId", note.notebookId).eq("principalId", principal._id),
    )
    .unique();
  return member?.role ?? null;
}

/** Owner-only actions also accept an agent its owner explicitly delegated. */
export function hasOwnerAuthority(
  principal: Principal,
  ownerId: Id<"principals">,
  action: OwnerAction,
): boolean {
  if (principal._id === ownerId) return true;
  return (
    principal.kind === "agent" &&
    principal.controllerId === ownerId &&
    (principal.delegations ?? []).includes(action)
  );
}

export async function loadNote(
  ctx: Ctx,
  principal: Principal,
  noteId: Id<"notes">,
  needed: Role,
) {
  const note = await ctx.db.get(noteId);
  // Missing and inaccessible notes are indistinguishable to the caller.
  if (!note) fail("not_found", "Note not found.");
  const role = await noteRole(ctx, principal, note);
  if (!role) fail("not_found", "Note not found.");
  if (!atLeast(role, needed))
    fail("denied", `This action needs ${needed} access to the note.`);
  return { note, role };
}

export async function loadNotebook(
  ctx: Ctx,
  principal: Principal,
  notebookId: Id<"notebooks">,
  needed: Role,
) {
  const notebook = await ctx.db.get(notebookId);
  if (!notebook) fail("not_found", "Notebook not found.");
  const role = await notebookRole(ctx, principal, notebook);
  if (!role) fail("not_found", "Notebook not found.");
  if (!atLeast(role, needed))
    fail("denied", `This action needs ${needed} access to the notebook.`);
  return { notebook, role };
}

/** Notebooks the caller owns or belongs to, with their role. Bounded. */
export async function accessibleNotebooks(ctx: Ctx, principal: Principal) {
  const owned = await ctx.db
    .query("notebooks")
    .withIndex("by_owner", (q) => q.eq("ownerId", principal._id))
    .take(500);
  const memberships = await ctx.db
    .query("notebookMembers")
    .withIndex("by_principal", (q) => q.eq("principalId", principal._id))
    .take(500);
  const result: { notebook: Doc<"notebooks">; role: Role }[] = owned.map(
    (notebook) => ({ notebook, role: "owner" as const }),
  );
  for (const member of memberships) {
    const notebook = await ctx.db.get(member.notebookId);
    if (notebook) result.push({ notebook, role: member.role });
  }
  return result;
}
