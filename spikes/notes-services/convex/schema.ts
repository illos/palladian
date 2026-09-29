import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  notes: defineTable({ ownerId: v.string(), readers: v.array(v.string()), editors: v.array(v.string()), title: v.string() }).index("by_owner", ["ownerId"]),
});
