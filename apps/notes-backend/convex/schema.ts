import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const role = v.union(v.literal("read"), v.literal("edit"));
export const noteOverride = v.union(
  v.literal("none"),
  v.literal("read"),
  v.literal("edit"),
);
export const delegation = v.union(
  v.literal("share"),
  v.literal("move"),
  v.literal("delete"),
  v.literal("publish"),
);

export default defineSchema({
  /** People and agents. Agents are individually addressable collaborators. */
  principals: defineTable({
    kind: v.union(v.literal("human"), v.literal("agent")),
    name: v.string(),
    // Humans: Better Auth user and normalized email.
    authUserId: v.optional(v.string()),
    email: v.optional(v.string()),
    defaultNotebookId: v.optional(v.id("notebooks")),
    // Agents: the person who approved the connection and what they delegated.
    controllerId: v.optional(v.id("principals")),
    delegations: v.optional(v.array(delegation)),
    autoShareRole: v.optional(role),
    clientName: v.optional(v.string()),
    // People: Trash retention in days; 0 keeps Trash until emptied manually.
    trashRetentionDays: v.optional(v.number()),
    // People: how many times the password was reset. Password sign-ins and
    // devices record the count they began under (D98, auth.ts, devices.ts).
    resetEpoch: v.optional(v.number()),
    createdAt: v.number(),
    disabledAt: v.optional(v.number()),
  })
    .index("by_auth_user", ["authUserId"])
    .index("by_email", ["email"])
    .index("by_controller", ["controllerId"]),

  /** One OAuth connection for an agent; revocation takes effect immediately. */
  connections: defineTable({
    agentId: v.id("principals"),
    controllerId: v.id("principals"),
    clientId: v.string(),
    clientName: v.string(),
    redirectHost: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_agent", ["agentId"])
    .index("by_agent_and_client_and_revoked_at", [
      "agentId",
      "clientId",
      "revokedAt",
    ])
    .index("by_controller", ["controllerId"]),

  connectionApprovals: defineTable({
    codeHash: v.string(),
    requestKey: v.string(),
    connectionId: v.id("connections"),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_code", ["codeHash"])
    .index("by_request_key", ["requestKey"]),

  notebooks: defineTable({
    ownerId: v.id("principals"),
    name: v.string(),
    description: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  /** Change counter for each notebook's library feed, kept apart from the notebook row. */
  notebookSequences: defineTable({
    notebookId: v.id("notebooks"),
    seq: v.number(),
  }).index("by_notebook", ["notebookId"]),

  notebookMembers: defineTable({
    notebookId: v.id("notebooks"),
    principalId: v.id("principals"),
    role,
    grantedBy: v.id("principals"),
    createdAt: v.number(),
  })
    .index("by_notebook_and_principal", ["notebookId", "principalId"])
    .index("by_principal", ["principalId"]),

  /** Note metadata only; content lives in noteContent so lists never read bodies. */
  notes: defineTable({
    notebookId: v.id("notebooks"),
    ownerId: v.id("principals"),
    creatorId: v.id("principals"),
    title: v.string(),
    preview: v.string(),
    createdAt: v.number(),
    editedAt: v.number(),
    lifecycle: v.union(v.literal("active"), v.literal("trashed")),
    trashedAt: v.optional(v.number()),
    // A private override: notebook members lose access unless granted explicitly.
    restricted: v.boolean(),
    seq: v.number(),
    clientKey: v.optional(v.string()),
  })
    .index("by_notebook_and_seq", ["notebookId", "seq"])
    .index("by_notebook_and_edited", ["notebookId", "editedAt"])
    .index("by_creator_and_client_key", ["creatorId", "clientKey"])
    .index("by_lifecycle_and_trashed_at", ["lifecycle", "trashedAt"]),

  /** Library feed entries for notes that left a notebook (moved or deleted). */
  noteTombstones: defineTable({
    notebookId: v.id("notebooks"),
    noteId: v.id("notes"),
    seq: v.number(),
  }).index("by_notebook_and_seq", ["notebookId", "seq"]),

  /** Explicit note grants. They override notebook defaults, including "none". */
  noteMembers: defineTable({
    noteId: v.id("notes"),
    principalId: v.id("principals"),
    role: noteOverride,
    grantedBy: v.id("principals"),
    createdAt: v.number(),
  })
    .index("by_note_and_principal", ["noteId", "principalId"])
    .index("by_principal", ["principalId"]),

  /** The accepted document. */
  noteContent: defineTable({
    noteId: v.id("notes"),
    doc: v.string(),
    revision: v.number(),
    updatedAt: v.number(),
    summaryDue: v.boolean(),
  }).index("by_note", ["noteId"]),

  /** Search projection, refreshed shortly after edits. */
  noteText: defineTable({
    noteId: v.id("notes"),
    notebookId: v.id("notebooks"),
    trashed: v.boolean(),
    text: v.string(),
  })
    .index("by_note", ["noteId"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["notebookId", "trashed"],
    }),

  /** Every accepted step; `revision` is the document revision after the step. */
  noteSteps: defineTable({
    noteId: v.id("notes"),
    revision: v.number(),
    step: v.string(),
    clientId: v.string(),
    actorId: v.id("principals"),
  }).index("by_note_and_revision", ["noteId", "revision"]),

  noteCheckpoints: defineTable({
    noteId: v.id("notes"),
    revision: v.number(),
    doc: v.string(),
  }).index("by_note_and_revision", ["noteId", "revision"]),

  /** History entries group consecutive edits by actor and idle time. */
  noteVersions: defineTable({
    noteId: v.id("notes"),
    baseRevision: v.number(),
    revision: v.number(),
    actorId: v.id("principals"),
    actorKind: v.union(v.literal("human"), v.literal("agent")),
    kind: v.union(v.literal("create"), v.literal("edit"), v.literal("restore")),
    startedAt: v.number(),
    endedAt: v.number(),
    deviceTime: v.optional(v.number()),
  }).index("by_note_and_revision", ["noteId", "revision"]),

  /** Idempotent results for retried logical writes. */
  receipts: defineTable({
    actorId: v.id("principals"),
    requestId: v.string(),
    digest: v.string(),
    noteId: v.id("notes"),
    revision: v.number(),
    createdAt: v.number(),
  }).index("by_actor_and_request", ["actorId", "requestId"]),

  /** The current public read-only link of a note; replaced links stay invalid. */
  publicLinks: defineTable({
    noteId: v.id("notes"),
    // A public capability for published content; the owner can copy it again.
    token: v.string(),
    createdBy: v.id("principals"),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_note", ["noteId"]),

  invitations: defineTable({
    email: v.string(),
    tokenHash: v.string(),
    invitedBy: v.optional(v.id("principals")),
    notebookId: v.optional(v.id("notebooks")),
    noteId: v.optional(v.id("notes")),
    role: v.optional(role),
    expiresAt: v.number(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    // Identifies the one account creation allowed to complete a claim.
    claimToken: v.optional(v.string()),
    acceptedAt: v.optional(v.number()),
    acceptedBy: v.optional(v.id("principals")),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["tokenHash"])
    .index("by_inviter", ["invitedBy"]),

  /**
   * Browsers that may hold an account's copies, by the hash of a secret only
   * the browser knows, and the password-reset count they last caught up with.
   * A browser behind the account's count clears that account's copies (D98).
   */
  devices: defineTable({
    secretHash: v.string(),
    principalId: v.id("principals"),
    resetEpoch: v.number(),
    boundAt: v.number(),
  })
    .index("by_secret_hash_and_principal", ["secretHash", "principalId"])
    .index("by_principal", ["principalId"]),

  /** Recent account emails, kept briefly to limit sends per subject and overall. */
  emailSends: defineTable({
    key: v.string(),
    createdAt: v.number(),
  })
    .index("by_key_and_created_at", ["key", "createdAt"])
    .index("by_created_at", ["createdAt"]),
});
