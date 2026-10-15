import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { Role } from "./access";

export const accessRole = v.union(
  v.literal("owner"),
  v.literal("edit"),
  v.literal("read"),
);

export const noteSummary = v.object({
  id: v.id("notes"),
  notebookId: v.id("notebooks"),
  title: v.string(),
  preview: v.string(),
  createdAt: v.number(),
  editedAt: v.number(),
  trashed: v.boolean(),
  trashedAt: v.union(v.number(), v.null()),
  restricted: v.boolean(),
  role: accessRole,
  seq: v.number(),
});
export type NoteSummary = Infer<typeof noteSummary>;

export function toSummary(note: Doc<"notes">, role: Role): NoteSummary {
  return {
    id: note._id,
    notebookId: note.notebookId,
    title: note.title,
    preview: note.preview,
    createdAt: note.createdAt,
    editedAt: note.editedAt,
    trashed: note.lifecycle === "trashed",
    trashedAt: note.trashedAt ?? null,
    restricted: note.restricted,
    role,
    seq: note.seq,
  };
}

export const noteEdit = v.union(
  v.object({
    type: v.literal("replace_text"),
    old_text: v.string(),
    new_text: v.string(),
  }),
  v.object({ type: v.literal("append"), markdown: v.string() }),
  v.object({
    type: v.literal("insert_after"),
    block_id: v.string(),
    markdown: v.string(),
  }),
  v.object({
    type: v.literal("insert_before"),
    block_id: v.string(),
    markdown: v.string(),
  }),
  v.object({
    type: v.literal("replace_block"),
    block_id: v.string(),
    markdown: v.string(),
    block_hash: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("delete_block"),
    block_id: v.string(),
    block_hash: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("set_checked"),
    block_id: v.string(),
    checked: v.boolean(),
  }),
  v.object({ type: v.literal("replace_all"), markdown: v.string() }),
);
