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
    // People: how many times the password was reset. A password sign-in
    // records the count it verified under (auth.ts).
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
   * Deltos notes for the one-off import (D100–D101), loaded with
   * `convex import --append`. Each row is linked to its note once imported, or
   * keeps a generic `failure` reason, and stays until verification has passed
   * and the operator clears the table.
   */
  deltosImports: defineTable({
    deltosId: v.string(),
    /** The Deltos notebook's name; null for a note outside any notebook. */
    notebook: v.union(v.string(), v.null()),
    title: v.string(),
    body: v.string(),
    fileNote: v.boolean(),
    fileExtract: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
    failure: v.optional(v.string()),
    // Set once imported; the row stays until verification and clearing.
    noteId: v.optional(v.id("notes")),
  }).index("by_failure_and_note", ["failure", "noteId"]),

  /**
   * Uploaded files (B1). The bytes live in the private R2 bucket under
   * `objects/<_id>` and are served only by the Worker after `files.ts` says
   * the caller may read them. Keyed by this ID, never by content hash, so
   * objects in shared notebooks cannot collide (Q11).
   */
  objects: defineTable({
    /** The owner of the note or notebook it was uploaded for (whose Trash retention applies). */
    ownerId: v.id("principals"),
    uploaderId: v.id("principals"),
    /** What it was uploaded for: exactly one of the two. */
    noteId: v.optional(v.id("notes")),
    notebookId: v.optional(v.id("notebooks")),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    /** Lowercase hex SHA-256 of the bytes, declared at ticket time and checked by the Worker. */
    sha256: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    /** SHA-256 of each upload ticket issued for it (a retried request adds one). */
    ticketHashes: v.array(v.string()),
    /** Pending: when its tickets stop working. Failed: when the record is removed. */
    expiresAt: v.optional(v.number()),
    /**
     * Until when an upload the Worker admitted may still write its bytes
     * (files.admitUpload). Byte deletion waits until after it.
     */
    leaseUntil: v.optional(v.number()),
    requestId: v.optional(v.string()),
    requestDigest: v.optional(v.string()),
    createdAt: v.number(),
    readyAt: v.optional(v.number()),
    /** Since when no active note references it; retention counts from here. */
    trashedAt: v.optional(v.number()),
  })
    .index("by_state_and_expires_at", ["state", "expiresAt"])
    .index("by_state_and_trashed_at", ["state", "trashedAt"])
    .index("by_uploader_and_request", ["uploaderId", "requestId"])
    .index("by_uploader_and_state_and_expires_at", [
      "uploaderId",
      "state",
      "expiresAt",
    ]),

  /**
   * Which notes reference which objects. `current`: the note's accepted
   * document references it now (otherwise only an earlier revision did).
   * `live`: current and the note is active. An object with no live reference
   * is in Trash (D41, D42).
   */
  objectRefs: defineTable({
    noteId: v.id("notes"),
    objectId: v.id("objects"),
    current: v.boolean(),
    live: v.boolean(),
  })
    .index("by_note_and_object", ["noteId", "objectId"])
    .index("by_note_and_current_and_live", ["noteId", "current", "live"])
    .index("by_object_and_live", ["objectId", "live"])
    .index("by_object_and_current", ["objectId", "current"]),

  /**
   * References a commit could not settle in its own transaction: the actor
   * may use the object through some note the bounded search did not reach.
   * files.verifyReference finishes the search in batches.
   */
  referenceChecks: defineTable({
    noteId: v.id("notes"),
    objectId: v.id("objects"),
    actorId: v.id("principals"),
    cursor: v.union(v.string(), v.null()),
    createdAt: v.number(),
  }).index("by_note_and_object_and_actor", ["noteId", "objectId", "actorId"]),

  /**
   * R2 keys whose bytes the Worker still has to delete (retry-safe queue).
   * Handed out only from `notBefore`, when no admitted upload can still write.
   */
  objectDeletions: defineTable({
    key: v.string(),
    requestedAt: v.number(),
    notBefore: v.optional(v.number()),
  }).index("by_not_before", ["notBefore"]),

  /** Recent account emails, kept briefly to limit sends per subject and overall. */
  emailSends: defineTable({
    key: v.string(),
    createdAt: v.number(),
  })
    .index("by_key_and_created_at", ["key", "createdAt"])
    .index("by_created_at", ["createdAt"]),

  /** A person's pinned notes (D102). Personal: other members never see them. */
  pins: defineTable({
    principalId: v.id("principals"),
    noteId: v.id("notes"),
    pinnedAt: v.number(),
  })
    .index("by_principal_and_note", ["principalId", "noteId"])
    .index("by_note", ["noteId"]),

  /** A person's sort order for All Notes ("all") or one notebook (D102). */
  listOrders: defineTable({
    principalId: v.id("principals"),
    list: v.string(),
    order: v.union(
      v.literal("edited"),
      v.literal("alpha"),
      v.literal("created"),
      v.literal("custom"),
    ),
  }).index("by_principal_and_list", ["principalId", "list"]),

  /**
   * Counts a person's arrangement writes, so a device can tell when a synced
   * arrangement includes (or has moved past) a change it made.
   */
  arrangementVersions: defineTable({
    principalId: v.id("principals"),
    version: v.number(),
  }).index("by_principal", ["principalId"]),

  /** A person's custom position for a note in a notebook (fractional key). */
  notePositions: defineTable({
    principalId: v.id("principals"),
    notebookId: v.id("notebooks"),
    noteId: v.id("notes"),
    key: v.string(),
  })
    .index("by_principal_and_notebook", ["principalId", "notebookId"])
    .index("by_principal_and_note", ["principalId", "noteId"])
    .index("by_note_and_notebook", ["noteId", "notebookId"]),
});
