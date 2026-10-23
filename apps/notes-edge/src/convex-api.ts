import { makeFunctionReference } from "convex/server";
import type { GenericId } from "convex/values";

/**
 * Typed references to the Convex functions the Worker calls.
 *
 * The generated `api` in `apps/notes-backend/convex/_generated` types itself
 * from the backend source, which drags Better Auth's Bun/DOM typings into any
 * program that imports it; those conflict with the Workers runtime types. So
 * the Worker names its functions here, and `contract/api-contract.ts` (checked
 * by `pnpm typecheck` under the backend's compiler settings) proves each
 * reference's arguments and return type are identical to the generated `api`.
 */

type Id<Table extends string> = GenericId<Table>;
type Role = "owner" | "edit" | "read";

export interface NoteSummary {
  id: Id<"notes">;
  notebookId: Id<"notebooks">;
  title: string;
  preview: string;
  createdAt: number;
  editedAt: number;
  trashed: boolean;
  trashedAt: number | null;
  restricted: boolean;
  role: Role;
  seq: number;
}

export interface NotebookView {
  id: Id<"notebooks">;
  name: string;
  description: string;
  role: Role;
  ownerId: Id<"principals">;
  ownerName: string;
  isDefault: boolean;
}

export interface OutlineEntry {
  id: string;
  type: string;
  depth: number;
  parentId: string | null;
  hash: string;
  markdown: string;
  checked?: boolean;
}

export type NoteEdit =
  | { type: "replace_text"; old_text: string; new_text: string }
  | { type: "append"; markdown: string }
  | { type: "insert_after"; block_id: string; markdown: string }
  | { type: "insert_before"; block_id: string; markdown: string }
  | {
      type: "replace_block";
      block_id: string;
      markdown: string;
      block_hash?: string;
    }
  | { type: "delete_block"; block_id: string; block_hash?: string }
  | { type: "set_checked"; block_id: string; checked: boolean }
  | { type: "replace_all"; markdown: string };

export interface VersionSummary {
  revision: number;
  baseRevision: number;
  kind: "create" | "edit" | "restore";
  actorId: Id<"principals">;
  actorName: string;
  actorKind: "human" | "agent";
  startedAt: number;
  endedAt: number;
  deviceTime: number | null;
}

export type ObjectState = "pending" | "ready" | "failed";

export interface ObjectMeta {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export const fns = {
  files: {
    createUpload: makeFunctionReference<
      "mutation",
      {
        noteId?: Id<"notes">;
        notebookId?: Id<"notebooks">;
        name: string;
        mimeType: string;
        size: number;
        sha256: string;
        requestId?: string;
      },
      {
        objectId: Id<"objects">;
        state: ObjectState;
        ticket: string | null;
        expiresAt: number | null;
        name: string;
        mimeType: string;
        replayed: boolean;
      }
    >("files:createUpload"),
    admitUpload: makeFunctionReference<
      "mutation",
      { objectId: string; ticket: string },
      | {
          status: "pending";
          size: number;
          sha256: string;
          mimeType: string;
          leaseUntil: number;
        }
      | { status: "ready"; size: number; sha256: string }
      | { status: "gone" }
      | { status: "denied" }
    >("files:admitUpload"),
    finalize: makeFunctionReference<
      "mutation",
      { objectId: string; ticket: string; size: number; sha256: string },
      { status: "ready" } | { status: "gone" } | { status: "denied" }
    >("files:finalize"),
    authorizeRead: makeFunctionReference<
      "query",
      { noteId: string; objectId: string },
      | ({ access: "granted" } & ObjectMeta)
      | { access: "unauthenticated" }
      | { access: "denied" }
    >("files:authorizeRead"),
    authorizePublicRead: makeFunctionReference<
      "query",
      { token: string; objectId: string },
      ObjectMeta | null
    >("files:authorizePublicRead"),
    deletionBatch: makeFunctionReference<
      "mutation",
      { limit: number },
      { id: Id<"objectDeletions">; key: string }[]
    >("files:deletionBatch"),
    confirmDeletions: makeFunctionReference<
      "mutation",
      { ids: Id<"objectDeletions">[] },
      null
    >("files:confirmDeletions"),
  },
  connections: {
    redeem: makeFunctionReference<
      "mutation",
      { code: string; requestKey: string },
      {
        connectionId: Id<"connections">;
        agentId: Id<"principals">;
        clientId: string;
      }
    >("connections:redeem"),
  },
  library: {
    notebooks: makeFunctionReference<
      "query",
      Record<string, never>,
      NotebookView[]
    >("library:notebooks"),
    recent: makeFunctionReference<
      "query",
      {
        notebookId?: Id<"notebooks">;
        cursor?: string;
        limit?: number;
        includeTrashed?: boolean;
      },
      { notes: NoteSummary[]; nextCursor: string | null }
    >("library:recent"),
    search: makeFunctionReference<
      "query",
      {
        query: string;
        notebookId?: Id<"notebooks">;
        includeTrashed?: boolean;
        limit?: number;
      },
      { summary: NoteSummary; excerpt: string }[]
    >("library:search"),
  },
  notes: {
    readMarkdown: makeFunctionReference<
      "query",
      {
        noteId: Id<"notes">;
        format: "markdown" | "outline";
        offset?: number;
        maxChars?: number;
      },
      {
        summary: NoteSummary;
        notebookName: string | null;
        revision: number;
        markdown: string | null;
        outline: OutlineEntry[] | null;
        totalChars: number;
        nextOffset: number | null;
      }
    >("notes:readMarkdown"),
    createFromMarkdown: makeFunctionReference<
      "mutation",
      {
        notebookId?: Id<"notebooks">;
        markdown: string;
        requestId?: string;
        sourceNoteIds?: Id<"notes">[];
      },
      {
        noteId: Id<"notes">;
        notebookId: Id<"notebooks">;
        title: string;
        revision: number;
        replayed: boolean;
      }
    >("notes:createFromMarkdown"),
    edit: makeFunctionReference<
      "mutation",
      {
        noteId: Id<"notes">;
        edits: NoteEdit[];
        expectedRevision?: number;
        requestId?: string;
        sourceNoteIds?: Id<"notes">[];
      },
      {
        revision: number;
        previousRevision: number;
        title: string;
        replayed: boolean;
      }
    >("notes:edit"),
    trash: makeFunctionReference<"mutation", { noteId: Id<"notes"> }, null>(
      "notes:trash",
    ),
    restore: makeFunctionReference<"mutation", { noteId: Id<"notes"> }, null>(
      "notes:restore",
    ),
  },
  notebooks: {
    create: makeFunctionReference<
      "mutation",
      { name: string; description?: string },
      Id<"notebooks">
    >("notebooks:create"),
  },
  history: {
    list: makeFunctionReference<
      "query",
      { noteId: Id<"notes">; before?: number; limit?: number },
      { versions: VersionSummary[]; nextBefore: number | null }
    >("history:list"),
    read: makeFunctionReference<
      "query",
      { noteId: Id<"notes">; revision: number },
      { revision: number; markdown: string; doc: string }
    >("history:read"),
    restore: makeFunctionReference<
      "mutation",
      {
        noteId: Id<"notes">;
        revision: number;
        expectedRevision: number;
        requestId?: string;
      },
      { revision: number; replayed: boolean }
    >("history:restore"),
  },
};

/** Convex validates IDs on arrival; agents hand us plain strings. */
export function asId<Table extends string>(value: string): Id<Table> {
  return value as Id<Table>;
}
