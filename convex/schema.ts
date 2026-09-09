import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  platformUsers: defineTable({
    provider: v.literal("better-auth"),
    subject: v.string(),
  }).index("by_provider_subject", ["provider", "subject"]),
});
