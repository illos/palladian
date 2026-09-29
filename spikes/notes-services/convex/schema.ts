import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  principals: defineTable({
    userId: v.string(),
    kind: v.union(v.literal("human"), v.literal("agent")),
  }).index("by_user", ["userId"]),
  notes: defineTable({
    ownerId: v.string(),
    readers: v.array(v.string()),
    editors: v.array(v.string()),
    title: v.string(),
    content: v.string(),
    version: v.number(),
  }).index("by_owner", ["ownerId"]),
  receipts: defineTable({
    noteId: v.id("notes"),
    actorId: v.string(),
    requestId: v.string(),
    digest: v.string(),
    version: v.number(),
    deviceTime: v.number(),
    acceptedAt: v.number(),
  })
    .index("by_request", ["noteId", "actorId", "requestId"])
    .index("by_note_version", ["noteId", "version"]),
  claims: defineTable({
    noteId: v.id("notes"),
    blockId: v.string(),
    holderId: v.string(),
    generation: v.number(),
    expiresAt: v.number(),
    cancelled: v.boolean(),
  }).index("by_note_block", ["noteId", "blockId"]),
});
