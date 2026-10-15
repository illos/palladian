import { betterAuth } from "better-auth/minimal";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import {
  fail,
  hasOwnerAuthority,
  noteRole,
  requireHuman,
  requirePrincipal,
} from "./access";
import { authOptions } from "./auth";
import { touchNote } from "./documents";
import { createNotebook } from "./notebooks";
import { role } from "./schema";

const INVITATION_TTL_MS = 14 * 24 * 60 * 60_000;

export function normalizeEmail(email: string) {
  const value = email.trim().toLowerCase();
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    fail("invalid", "Enter a valid email address.");
  return value;
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function newToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return base64url(new Uint8Array(digest));
}

/** Grant the access an invitation describes to a principal. */
async function applyGrant(
  ctx: MutationCtx,
  invitation: Doc<"invitations">,
  principalId: Id<"principals">,
) {
  if (!invitation.role || !invitation.invitedBy) return;
  const now = Date.now();
  if (invitation.notebookId && (await ctx.db.get(invitation.notebookId))) {
    const existing = await ctx.db
      .query("notebookMembers")
      .withIndex("by_notebook_and_principal", (q) =>
        q
          .eq("notebookId", invitation.notebookId!)
          .eq("principalId", principalId),
      )
      .unique();
    if (existing) await ctx.db.patch(existing._id, { role: invitation.role });
    else
      await ctx.db.insert("notebookMembers", {
        notebookId: invitation.notebookId,
        principalId,
        role: invitation.role,
        grantedBy: invitation.invitedBy,
        createdAt: now,
      });
  }
  if (invitation.noteId && (await ctx.db.get(invitation.noteId))) {
    const existing = await ctx.db
      .query("noteMembers")
      .withIndex("by_note_and_principal", (q) =>
        q.eq("noteId", invitation.noteId!).eq("principalId", principalId),
      )
      .unique();
    if (existing) await ctx.db.patch(existing._id, { role: invitation.role });
    else
      await ctx.db.insert("noteMembers", {
        noteId: invitation.noteId,
        principalId,
        role: invitation.role,
        grantedBy: invitation.invitedBy,
        createdAt: now,
      });
    const note = await ctx.db.get(invitation.noteId);
    if (note) await touchNote(ctx, note);
  }
}

/** Invite someone by email to a notebook or note. Existing accounts are granted directly. */
export const create = mutation({
  args: {
    email: v.string(),
    notebookId: v.optional(v.id("notebooks")),
    noteId: v.optional(v.id("notes")),
    role,
  },
  returns: v.union(
    v.object({ kind: v.literal("granted"), principalId: v.id("principals") }),
    v.object({
      kind: v.literal("invited"),
      token: v.string(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const actor = await requireHuman(ctx);
    if (!!args.notebookId === !!args.noteId)
      fail("invalid", "Invite to exactly one notebook or note.");
    let ownerId: Id<"principals">;
    if (args.notebookId) {
      const notebook = await ctx.db.get(args.notebookId);
      if (!notebook) fail("not_found", "Notebook not found.");
      ownerId = notebook.ownerId;
    } else {
      const note = await ctx.db.get(args.noteId!);
      if (!note || !(await noteRole(ctx, actor, note)))
        fail("not_found", "Note not found.");
      ownerId = note.ownerId;
    }
    if (!hasOwnerAuthority(actor, ownerId, "share"))
      fail("denied", "Only the owner can invite people.");
    const email = normalizeEmail(args.email);
    const token = newToken();
    const now = Date.now();
    const invitation = {
      email,
      tokenHash: await hashToken(token),
      invitedBy: actor._id,
      role: args.role,
      expiresAt: now + INVITATION_TTL_MS,
      createdAt: now,
      ...(args.notebookId ? { notebookId: args.notebookId } : {}),
      ...(args.noteId ? { noteId: args.noteId } : {}),
    };
    const existing = await ctx.db
      .query("principals")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing && existing.kind === "human" && !existing.disabledAt) {
      if (existing._id === ownerId)
        fail("invalid", "The owner already has access.");
      const id = await ctx.db.insert("invitations", {
        ...invitation,
        acceptedAt: now,
        acceptedBy: existing._id,
      });
      await applyGrant(ctx, (await ctx.db.get(id))!, existing._id);
      return { kind: "granted" as const, principalId: existing._id };
    }
    await ctx.db.insert("invitations", invitation);
    return { kind: "invited" as const, token, expiresAt: invitation.expiresAt };
  },
});

/** What an invitation link offers, without revealing anything beyond it. */
export const preview = query({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      email: v.string(),
      inviterName: v.union(v.string(), v.null()),
      target: v.union(v.string(), v.null()),
      status: v.union(
        v.literal("open"),
        v.literal("used"),
        v.literal("revoked"),
      ),
      expiresAt: v.number(),
      accountExists: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    if (args.token.length < 20 || args.token.length > 100) return null;
    const tokenHash = await hashToken(args.token);
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!invitation) return null;
    const inviter = invitation.invitedBy
      ? await ctx.db.get(invitation.invitedBy)
      : null;
    let target: string | null = null;
    if (invitation.notebookId)
      target = (await ctx.db.get(invitation.notebookId))?.name ?? null;
    else if (invitation.noteId)
      target = (await ctx.db.get(invitation.noteId))?.title || "a note";
    const account = await ctx.db
      .query("principals")
      .withIndex("by_email", (q) => q.eq("email", invitation.email))
      .unique();
    return {
      email: invitation.email,
      inviterName: inviter?.name ?? null,
      target,
      status:
        invitation.revokedAt !== undefined
          ? ("revoked" as const)
          : invitation.acceptedAt !== undefined
            ? ("used" as const)
            : ("open" as const),
      expiresAt: invitation.expiresAt,
      accountExists: account !== null,
    };
  },
});

export const claim = internalMutation({
  args: { tokenHash: v.string(), now: v.number() },
  returns: v.object({ email: v.string(), claim: v.string() }),
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (
      !invitation ||
      invitation.revokedAt !== undefined ||
      invitation.acceptedAt !== undefined ||
      invitation.expiresAt <= args.now
    )
      throw new ConvexError({
        code: "invalid",
        message: "This invitation is no longer valid.",
      });
    if (
      invitation.claimedAt !== undefined &&
      args.now - invitation.claimedAt < 60_000
    )
      throw new ConvexError({
        code: "conflict",
        message: "This invitation is being accepted.",
      });
    const existing = await ctx.db
      .query("principals")
      .withIndex("by_email", (q) => q.eq("email", invitation.email))
      .unique();
    if (existing)
      throw new ConvexError({
        code: "conflict",
        message:
          "An account already exists for this email. Sign in, then open the invitation.",
      });
    const claim = newToken();
    await ctx.db.patch(invitation._id, {
      claimedAt: args.now,
      claimToken: claim,
    });
    return { email: invitation.email, claim };
  },
});

export const unclaim = internalMutation({
  args: { tokenHash: v.string(), claim: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (
      invitation &&
      invitation.acceptedAt === undefined &&
      invitation.claimToken === args.claim
    )
      await ctx.db.patch(invitation._id, {
        claimedAt: undefined,
        claimToken: undefined,
      });
    return null;
  },
});

export const complete = internalMutation({
  args: {
    tokenHash: v.string(),
    claim: v.string(),
    authUserId: v.string(),
    name: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    // Revalidate at commit: revocation or expiry during account creation wins.
    if (
      !invitation ||
      invitation.acceptedAt !== undefined ||
      invitation.revokedAt !== undefined ||
      invitation.expiresAt <= now ||
      invitation.claimToken !== args.claim
    )
      throw new ConvexError({
        code: "invalid",
        message: "This invitation is no longer valid.",
      });
    const taken = await ctx.db
      .query("principals")
      .withIndex("by_email", (q) => q.eq("email", invitation.email))
      .unique();
    if (taken)
      throw new ConvexError({
        code: "conflict",
        message: "An account already exists for this email.",
      });
    const principalId = await ctx.db.insert("principals", {
      kind: "human",
      name: args.name,
      authUserId: args.authUserId,
      // Accepting an emailed invitation verifies this address.
      email: invitation.email,
      createdAt: now,
    });
    const notebookId = await createNotebook(
      ctx,
      { _id: principalId, kind: "human" },
      "Notes",
      "",
    );
    await ctx.db.patch(principalId, { defaultNotebookId: notebookId });
    await ctx.db.patch(invitation._id, {
      acceptedAt: now,
      acceptedBy: principalId,
      claimToken: undefined,
    });
    await applyGrant(ctx, invitation, principalId);
    return null;
  },
});

/** Create an account from an invitation; the browser then signs in normally. */
export const accept = action({
  args: { token: v.string(), name: v.string(), password: v.string() },
  returns: v.object({ email: v.string() }),
  handler: async (ctx, args): Promise<{ email: string }> => {
    const name = args.name.trim();
    if (!name || name.length > 100) fail("invalid", "Enter your name.");
    if (args.token.length < 20 || args.token.length > 100)
      fail("invalid", "This invitation is no longer valid.");
    const tokenHash = await hashToken(args.token);
    const { email, claim }: { email: string; claim: string } =
      await ctx.runMutation(internal.invitations.claim, {
        tokenHash,
        now: Date.now(),
      });
    let authUserId: string;
    try {
      const options = authOptions(ctx);
      const auth = betterAuth({
        ...options,
        emailAndPassword: {
          ...options.emailAndPassword,
          disableSignUp: false,
          autoSignIn: false,
        },
      });
      const result = await auth.api.signUpEmail({
        body: { email, password: args.password, name },
      });
      authUserId = result.user.id;
    } catch (error) {
      await ctx.runMutation(internal.invitations.unclaim, { tokenHash, claim });
      const message =
        error instanceof Error && /password/i.test(error.message)
          ? "Choose a password of at least 12 characters."
          : "The account could not be created.";
      fail("invalid", message);
    }
    try {
      await ctx.runMutation(internal.invitations.complete, {
        tokenHash,
        claim,
        authUserId,
        name,
      });
    } catch (error) {
      // The invitation stopped being valid while the login was created: remove
      // that login so it cannot be used and the email stays free.
      await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
        input: {
          model: "account",
          where: [{ field: "userId", value: authUserId }],
        },
        paginationOpts: { numItems: 20, cursor: null },
      });
      await ctx.runMutation(components.betterAuth.adapter.deleteOne, {
        input: { model: "user", where: [{ field: "_id", value: authUserId }] },
      });
      await ctx.runMutation(internal.invitations.unclaim, { tokenHash, claim });
      throw error;
    }
    return { email };
  },
});

/** Accept an invitation into an existing account with the invited email. */
export const acceptExisting = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requireHuman(ctx);
    if (args.token.length < 20 || args.token.length > 100)
      fail("invalid", "This invitation is no longer valid.");
    const tokenHash = await hashToken(args.token);
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (
      !invitation ||
      invitation.revokedAt !== undefined ||
      invitation.acceptedAt !== undefined ||
      invitation.expiresAt <= Date.now()
    )
      fail("invalid", "This invitation is no longer valid.");
    if (invitation.email !== actor.email)
      fail("denied", "This invitation was sent to a different email address.");
    await ctx.db.patch(invitation._id, {
      acceptedAt: Date.now(),
      acceptedBy: actor._id,
    });
    await applyGrant(ctx, invitation, actor._id);
    return null;
  },
});

export const pending = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.id("invitations"),
      email: v.string(),
      notebookId: v.union(v.id("notebooks"), v.null()),
      noteId: v.union(v.id("notes"), v.null()),
      role: v.union(role, v.null()),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const actor = await requirePrincipal(ctx);
    const rows = await ctx.db
      .query("invitations")
      .withIndex("by_inviter", (q) => q.eq("invitedBy", actor._id))
      .order("desc")
      .take(100);
    return rows
      .filter(
        (row) => row.acceptedAt === undefined && row.revokedAt === undefined,
      )
      .map((row) => ({
        id: row._id,
        email: row.email,
        notebookId: row.notebookId ?? null,
        noteId: row.noteId ?? null,
        role: row.role ?? null,
        expiresAt: row.expiresAt,
      }));
  },
});

export const revoke = mutation({
  args: { invitationId: v.id("invitations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await requirePrincipal(ctx);
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation || invitation.invitedBy !== actor._id)
      fail("not_found", "Invitation not found.");
    if (invitation.acceptedAt === undefined)
      await ctx.db.patch(invitation._id, { revokedAt: Date.now() });
    return null;
  },
});
