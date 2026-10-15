import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { fail, getPrincipal, requireHuman } from "./access";
import { hashToken, newToken } from "./invitations";
import { delegation, role } from "./schema";

const APPROVAL_TTL_MS = 5 * 60_000;

function cleanLabel(value: string, max: number, what: string) {
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > max) fail("invalid", `Invalid ${what}.`);
  return text;
}

/**
 * The consent step of an agent's OAuth sign-in. The person chooses which of
 * their notebooks the agent may use; those become ordinary memberships. The
 * returned one-time code lets the Worker finish the OAuth authorization.
 */
export const approve = mutation({
  args: {
    requestKey: v.string(),
    clientId: v.string(),
    clientName: v.string(),
    redirectHost: v.string(),
    agentName: v.string(),
    agentId: v.optional(v.id("principals")),
    // Explicit consent to give an existing agent to a different client.
    transfer: v.optional(v.boolean()),
    // The complete choice for every notebook the person owns; "none" removes access.
    notebooks: v.array(
      v.object({
        notebookId: v.id("notebooks"),
        role: v.union(role, v.literal("none")),
      }),
    ),
    autoShareRole: v.union(role, v.null()),
  },
  returns: v.object({ code: v.string(), agentId: v.id("principals") }),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    if (args.requestKey.length < 16 || args.requestKey.length > 128)
      fail("invalid", "Invalid authorization request.");
    if (args.clientId.length > 2048) fail("invalid", "Invalid client.");
    if (args.notebooks.length > 200) fail("invalid", "Too many notebooks.");
    const consumed = await ctx.db
      .query("connectionApprovals")
      .withIndex("by_request_key", (q) => q.eq("requestKey", args.requestKey))
      .take(20);
    if (consumed.some((row) => row.usedAt !== undefined))
      fail("invalid", "This authorization request was already completed.");
    const clientName = cleanLabel(args.clientName, 100, "client name");
    const redirectHost = cleanLabel(args.redirectHost, 255, "redirect host");
    const now = Date.now();
    let agentId: Id<"principals">;
    if (args.agentId) {
      const agent = await ctx.db.get(args.agentId);
      if (!agent || agent.kind !== "agent" || agent.controllerId !== person._id)
        fail("not_found", "Agent not found.");
      // Continuity comes from the client identity, never from its display name.
      const sameClient = await ctx.db
        .query("connections")
        .withIndex("by_agent_and_client_and_revoked_at", (q) =>
          q.eq("agentId", agent._id).eq("clientId", args.clientId),
        )
        .first();
      if (!sameClient && args.transfer !== true)
        fail(
          "invalid",
          "This app is not the one this agent was connected with. Confirm the transfer to reuse it.",
        );
      agentId = agent._id;
      await ctx.db.patch(agentId, {
        disabledAt: undefined,
        autoShareRole: args.autoShareRole ?? undefined,
      });
    } else {
      agentId = await ctx.db.insert("principals", {
        kind: "agent",
        name: cleanLabel(args.agentName, 60, "agent name"),
        controllerId: person._id,
        delegations: [],
        clientName,
        createdAt: now,
        ...(args.autoShareRole ? { autoShareRole: args.autoShareRole } : {}),
      });
    }
    const chosen = new Map(args.notebooks.map((n) => [n.notebookId, n.role]));
    for (const notebookId of chosen.keys()) {
      const notebook = await ctx.db.get(notebookId);
      if (!notebook || notebook.ownerId !== person._id)
        fail("denied", "You can only share notebooks you own.");
    }
    // Memberships in this person's notebooks follow the submitted choice exactly.
    const current = await ctx.db
      .query("notebookMembers")
      .withIndex("by_principal", (q) => q.eq("principalId", agentId))
      .take(500);
    for (const member of current) {
      const notebook = await ctx.db.get(member.notebookId);
      if (!notebook || notebook.ownerId !== person._id) continue;
      const choice = chosen.get(member.notebookId) ?? "none";
      if (choice === "none") await ctx.db.delete(member._id);
      else if (choice !== member.role)
        await ctx.db.patch(member._id, { role: choice });
      chosen.delete(member.notebookId);
    }
    for (const [notebookId, choice] of chosen) {
      if (choice === "none") continue;
      await ctx.db.insert("notebookMembers", {
        notebookId,
        principalId: agentId,
        role: choice,
        grantedBy: person._id,
        createdAt: now,
      });
    }
    const connectionId = await ctx.db.insert("connections", {
      agentId,
      controllerId: person._id,
      clientId: args.clientId,
      clientName,
      redirectHost,
      createdAt: now,
    });
    const code = newToken();
    await ctx.db.insert("connectionApprovals", {
      codeHash: await hashToken(code),
      requestKey: args.requestKey,
      connectionId,
      expiresAt: now + APPROVAL_TTL_MS,
    });
    return { code, agentId };
  },
});

/** Called by the Worker: exchange a one-time approval code for the connection. */
export const redeem = mutation({
  args: { code: v.string(), requestKey: v.string() },
  returns: v.object({
    connectionId: v.id("connections"),
    agentId: v.id("principals"),
    clientId: v.string(),
  }),
  handler: async (ctx, args) => {
    if (args.code.length < 20 || args.code.length > 100)
      fail("invalid", "Invalid approval.");
    const codeHash = await hashToken(args.code);
    const row = await ctx.db
      .query("connectionApprovals")
      .withIndex("by_code", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (
      !row ||
      row.usedAt !== undefined ||
      row.expiresAt <= Date.now() ||
      row.requestKey !== args.requestKey
    )
      fail("invalid", "This approval is no longer valid.");
    // One authorization request completes at most once, whichever approval arrives first.
    const siblings = await ctx.db
      .query("connectionApprovals")
      .withIndex("by_request_key", (q) => q.eq("requestKey", args.requestKey))
      .take(20);
    if (siblings.some((other) => other.usedAt !== undefined))
      fail("invalid", "This approval is no longer valid.");
    const now = Date.now();
    for (const other of siblings)
      await ctx.db.patch(other._id, { usedAt: now });
    const connection = await ctx.db.get(row.connectionId);
    if (!connection || connection.revokedAt !== undefined)
      fail("invalid", "This approval is no longer valid.");
    // Re-authorizing replaces the client's earlier grant; retire its active connections.
    const active = await ctx.db
      .query("connections")
      .withIndex("by_agent_and_client_and_revoked_at", (q) =>
        q
          .eq("agentId", connection.agentId)
          .eq("clientId", connection.clientId)
          .eq("revokedAt", undefined),
      )
      .take(100);
    for (const old of active)
      if (old._id !== connection._id)
        await ctx.db.patch(old._id, { revokedAt: now });
    return {
      connectionId: connection._id,
      agentId: connection.agentId,
      clientId: connection.clientId,
    };
  },
});

/** The caller's agents, their connections and notebook access. */
export const mine = query({
  args: {},
  returns: v.array(
    v.object({
      agentId: v.id("principals"),
      name: v.string(),
      clientName: v.union(v.string(), v.null()),
      delegations: v.array(delegation),
      autoShareRole: v.union(role, v.null()),
      disabled: v.boolean(),
      connections: v.array(
        v.object({
          id: v.id("connections"),
          clientId: v.string(),
          clientName: v.string(),
          redirectHost: v.string(),
          createdAt: v.number(),
          revokedAt: v.union(v.number(), v.null()),
        }),
      ),
      notebooks: v.array(
        v.object({ notebookId: v.id("notebooks"), name: v.string(), role }),
      ),
      noteGrants: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const person = await getPrincipal(ctx);
    if (!person || person.kind !== "human") return [];
    const agents = await ctx.db
      .query("principals")
      .withIndex("by_controller", (q) => q.eq("controllerId", person._id))
      .take(100);
    const result = [];
    for (const agent of agents) {
      const connections = await ctx.db
        .query("connections")
        .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
        .order("desc")
        .take(20);
      const memberships = await ctx.db
        .query("notebookMembers")
        .withIndex("by_principal", (q) => q.eq("principalId", agent._id))
        .take(200);
      const notebooks = [];
      for (const member of memberships) {
        const notebook = await ctx.db.get(member.notebookId);
        if (notebook)
          notebooks.push({
            notebookId: notebook._id,
            name: notebook.name,
            role: member.role,
          });
      }
      const grants = await ctx.db
        .query("noteMembers")
        .withIndex("by_principal", (q) => q.eq("principalId", agent._id))
        .take(500);
      result.push({
        agentId: agent._id,
        noteGrants: grants.filter((g) => g.role !== "none").length,
        name: agent.name,
        clientName: agent.clientName ?? null,
        delegations: agent.delegations ?? [],
        autoShareRole: agent.autoShareRole ?? null,
        disabled: agent.disabledAt !== undefined,
        connections: connections.map((c) => ({
          id: c._id,
          clientId: c.clientId,
          clientName: c.clientName,
          redirectHost: c.redirectHost,
          createdAt: c.createdAt,
          revokedAt: c.revokedAt ?? null,
        })),
        notebooks,
      });
    }
    return result;
  },
});

export const revoke = mutation({
  args: { connectionId: v.id("connections") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const connection = await ctx.db.get(args.connectionId);
    if (!connection || connection.controllerId !== person._id)
      fail("not_found", "Connection not found.");
    if (connection.revokedAt === undefined)
      await ctx.db.patch(connection._id, { revokedAt: Date.now() });
    return null;
  },
});

export const updateAgent = mutation({
  args: {
    agentId: v.id("principals"),
    name: v.optional(v.string()),
    delegations: v.optional(v.array(delegation)),
    autoShareRole: v.optional(v.union(role, v.null())),
    disabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const person = await requireHuman(ctx);
    const agent = await ctx.db.get(args.agentId);
    if (!agent || agent.kind !== "agent" || agent.controllerId !== person._id)
      fail("not_found", "Agent not found.");
    await ctx.db.patch(agent._id, {
      ...(args.name !== undefined
        ? { name: cleanLabel(args.name, 60, "agent name") }
        : {}),
      ...(args.delegations !== undefined
        ? { delegations: [...new Set(args.delegations)] }
        : {}),
      ...(args.autoShareRole !== undefined
        ? { autoShareRole: args.autoShareRole ?? undefined }
        : {}),
      ...(args.disabled !== undefined
        ? { disabledAt: args.disabled ? Date.now() : undefined }
        : {}),
    });
    return null;
  },
});
