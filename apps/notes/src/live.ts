import { diffStep, parseStoredDoc } from "@palladian/notes-core/document";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { plainText } from "@palladian/notes-core/projection";
import { api } from "@palladian/notes-backend/api";
import { ConvexReactClient } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { Id } from "@palladian/notes-backend/dataModel";
import type { Draft, RemoteSummary, NotesStore } from "./cache";
import { TransportError, type NoteTransport, type StepBatch } from "./channel";
import type { SessionController } from "./session";
import type { createAuthService } from "./auth-service";

type Auth = ReturnType<typeof createAuthService>["auth"];
type Summary = FunctionReturnType<typeof api.library.shared>[number];
export type Profile = NonNullable<FunctionReturnType<typeof api.account.me>>;
export type SearchHit = FunctionReturnType<typeof api.library.search>[number];

export interface LiveState {
  /** Authenticated to the backend for this account. */
  ready: boolean;
  accountId: string | null;
  profile: Profile | null;
  connected: boolean;
}

/** Equal documents, ignoring block IDs the server may have assigned. */
function sameContent(a: ProseMirrorNode, b: ProseMirrorNode) {
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).flatMap(([key, item]) =>
              key === "id" ? [] : [[key, strip(item)]],
            ),
          )
        : value;
  return (
    JSON.stringify(strip(a.toJSON())) === JSON.stringify(strip(b.toJSON()))
  );
}

function toRemote(row: Summary): RemoteSummary {
  return {
    id: row.id,
    title: row.title,
    preview: row.preview,
    updatedAt: row.editedAt,
    notebookId: row.notebookId,
    role: row.role,
    trashed: row.trashed,
  };
}

/** The `sub` claim of a JWT, read without verification (the server verifies). */
export function tokenSubject(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const payload: unknown = JSON.parse(json);
    return typeof payload === "object" &&
      payload !== null &&
      "sub" in payload &&
      typeof payload.sub === "string"
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

export function transportError(error: unknown): TransportError {
  if (error instanceof ConvexError) {
    const data = error.data as
      { code?: unknown; message?: unknown } | undefined;
    return new TransportError(
      typeof data?.code === "string" ? data.code : "invalid",
      typeof data?.message === "string" ? data.message : "Request rejected.",
    );
  }
  return new TransportError("transient", "Connection unavailable.");
}

/**
 * The deferred live layer: authenticates the Convex client from the Better
 * Auth session, mirrors the library into the local cache, and gives editors a
 * transport. The notes UI keeps reading from the cache throughout.
 */
export class LiveController {
  readonly client: ConvexReactClient;
  private readonly auth: Auth;
  private readonly store: NotesStore;
  private readonly session: SessionController;
  private state: LiveState = {
    ready: false,
    accountId: null,
    profile: null,
    connected: false,
  };
  private readonly listeners = new Set<() => void>();
  private stops: (() => void)[] = [];
  private feeds = new Map<string, () => void>();
  private accessQueue: Promise<unknown> = Promise.resolve();
  private visibleNotebooks: Set<string> | null = null;
  private fetchQueue = new Map<string, number>();
  private fetching = 0;
  private openNotes = new Set<string>();
  private syncingDrafts = false;
  private tokenRequest = 0;
  private token: {
    accountId: string;
    generation: number;
    value: string;
  } | null = null;

  constructor(
    convexURL: string,
    auth: Auth,
    store: NotesStore,
    session: SessionController,
  ) {
    this.client = new ConvexReactClient(convexURL, {
      unsavedChangesWarning: false,
    });
    this.auth = auth;
    this.store = store;
    this.session = session;
    this.client.subscribeToConnectionState((connection) => {
      const connected = connection.isWebSocketConnected;
      if (connected !== this.state.connected) this.update({ connected });
    });
    session.subscribe(() => this.follow());
    this.follow();
  }

  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  private update(next: Partial<LiveState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Follow the session: authenticate when ready, stop when the account goes away. */
  private follow() {
    const snapshot = this.session.getSnapshot();
    const accountId =
      snapshot.status === "ready" ||
      ((snapshot.status === "retrying" || snapshot.status === "connecting") &&
        snapshot.accountId === this.state.accountId)
        ? snapshot.accountId
        : null;
    if (accountId === this.state.accountId) return;
    this.stopSync();
    this.token = null;
    if (!accountId) {
      this.client.clearAuth();
      this.update({ ready: false, accountId: null, profile: null });
      return;
    }
    this.update({ ready: false, accountId, profile: null });
    this.client.setAuth(
      async ({ forceRefreshToken }) => {
        const current = this.session.getSnapshot();
        if (current.accountId !== accountId || current.status === "signed-out")
          return null;
        if (
          !forceRefreshToken &&
          this.token?.accountId === accountId &&
          this.token.generation === current.generation
        )
          return this.token.value;
        const request = ++this.tokenRequest;
        try {
          const result = await this.auth.convex.token({
            fetchOptions: { throw: false },
          });
          const value = result.data?.token ?? null;
          const after = this.session.getSnapshot();
          // Only a token for this exact account and session generation, from the
          // newest request, may authenticate this account's sync.
          if (
            request !== this.tokenRequest ||
            after.accountId !== accountId ||
            after.generation !== current.generation ||
            this.state.accountId !== accountId
          )
            return null;
          if (value && tokenSubject(value) !== accountId) {
            this.token = null;
            // The browser's credentials belong to someone else now; let the
            // session controller notice and isolate the previous account.
            this.session.retry();
            return null;
          }
          this.token = value
            ? { accountId, generation: current.generation, value }
            : null;
          return value;
        } catch {
          return null;
        }
      },
      (authenticated) => {
        if (this.state.accountId !== accountId) return;
        if (authenticated && !this.state.ready) {
          this.update({ ready: true });
          this.startSync(accountId);
        } else if (!authenticated && this.state.ready) {
          this.stopSync();
          this.update({ ready: false });
        }
      },
    );
  }

  private watch<Q extends FunctionReference<"query">>(
    query: Q,
    args: Q["_args"],
    onValue: (value: FunctionReturnType<Q>) => void,
    onError?: (error: unknown) => void,
  ) {
    const watch = this.client.watchQuery(query, args);
    const read = () => {
      let value: FunctionReturnType<Q> | undefined;
      try {
        value = watch.localQueryResult();
      } catch (error) {
        onError?.(error);
        return;
      }
      if (value !== undefined) onValue(value);
    };
    const stop = watch.onUpdate(read);
    read();
    return stop;
  }

  private startSync(accountId: string) {
    const current = () =>
      this.state.accountId === accountId && this.state.ready;
    this.stops.push(
      this.watch(api.account.me, {}, (profile) => {
        if (current()) this.update({ profile });
      }),
    );
    // One consistent snapshot of visible notebooks and shared notes; snapshots
    // apply strictly in order.
    this.stops.push(
      this.watch(api.library.access, {}, (snapshot) => {
        if (!current() || !snapshot) return;
        this.accessQueue = this.accessQueue
          .then(() =>
            current() ? this.applyAccess(accountId, snapshot) : undefined,
          )
          .catch(() => undefined);
      }),
    );
    void this.syncDrafts();
  }

  private stopSync() {
    for (const stop of this.stops) stop();
    this.stops = [];
    for (const stop of this.feeds.values()) stop();
    this.feeds.clear();
    this.fetchQueue.clear();
    this.visibleNotebooks = null;
  }

  private async applyAccess(
    accountId: string,
    snapshot: NonNullable<FunctionReturnType<typeof api.library.access>>,
  ) {
    const ids = new Set(snapshot.notebooks.map((n) => n.id as string));
    const shared = new Set(snapshot.shared.map((n) => n.id as string));
    this.visibleNotebooks = ids;
    const fence = await this.store.captureFence(accountId);
    await this.store.setNotebooks(
      accountId,
      snapshot.notebooks.map((n) => ({
        id: n.id,
        name: n.name,
        description: n.description,
        role: n.role,
        ownerName: n.ownerName,
        isDefault: n.isDefault,
      })),
      fence,
    );
    const fenced = await this.store.cacheSummaries(
      accountId,
      snapshot.shared.map(toRemote),
      [],
      fence,
    );
    // Anything cached that a complete snapshot no longer covers is revoked; a
    // truncated snapshot never implies revocation.
    if (snapshot.complete)
      await this.store.reconcileAccess(accountId, ids, shared, fence);
    for (const row of snapshot.shared)
      if (!fenced.includes(row.id))
        this.queueFetch(accountId, row.id, row.editedAt);
    void this.recheckAccess(accountId, fenced);
    for (const [id, stop] of this.feeds)
      if (!ids.has(id)) {
        stop();
        this.feeds.delete(id);
      }
    for (const id of ids)
      if (!this.feeds.has(id)) void this.followFeed(accountId, id);
  }

  private async followFeed(accountId: string, notebookId: string) {
    const key = "notebook:" + notebookId;
    const after = await this.store.cursor(accountId, key);
    if (
      this.state.accountId !== accountId ||
      !this.visibleNotebooks?.has(notebookId)
    )
      return;
    this.feeds.get(notebookId)?.();
    let handled = false;
    const stop = this.watch(
      api.library.changes,
      { notebookId: notebookId as Id<"notebooks">, after },
      (page) => {
        if (handled || !page.access || this.state.accountId !== accountId)
          return;
        if (!page.notes.length && !page.removed.length && page.cursor === after)
          return;
        handled = true;
        void (async () => {
          try {
            const fence = await this.store.captureFence(accountId);
            const fenced = await this.store.cacheSummaries(
              accountId,
              page.notes.map(toRemote),
              page.removed as string[],
              fence,
              { key, value: page.cursor },
            );
            for (const note of page.notes)
              if (!fenced.includes(note.id))
                this.queueFetch(accountId, note.id, note.editedAt);
            void this.recheckAccess(accountId, fenced);
          } catch {
            handled = false;
            return;
          }
          if (this.feeds.get(notebookId) === stop)
            void this.followFeed(accountId, notebookId);
        })();
      },
    );
    this.feeds.set(notebookId, stop);
  }

  /**
   * Notes fenced after a revocation reappeared in a feed or snapshot, which may
   * be older than the revocation. Ask the server now; only an answer to a
   * request issued after the fence lifts it.
   */
  private async recheckAccess(accountId: string, ids: string[]) {
    for (const id of ids) {
      const checkedAt = Date.now();
      let meta;
      try {
        meta = await this.client.query(api.notes.get, {
          noteId: id as Id<"notes">,
        });
      } catch {
        continue;
      }
      if (!meta || this.state.accountId !== accountId) continue;
      try {
        await this.store.allowNotes(accountId, [id], checkedAt);
        const fence = await this.store.captureFence(accountId);
        const still = await this.store.cacheSummaries(
          accountId,
          [toRemote(meta.summary)],
          [],
          fence,
        );
        if (!still.length)
          this.queueFetch(accountId, id, meta.summary.editedAt);
      } catch {
        /* retried on the next update */
      }
    }
  }

  private queueFetch(accountId: string, noteId: string, updatedAt: number) {
    if (this.openNotes.has(noteId)) return;
    this.fetchQueue.set(noteId, updatedAt);
    this.pump(accountId);
  }

  /** Cache current note text in the background, a few at a time. */
  private pump(accountId: string) {
    while (this.fetching < 3 && this.fetchQueue.size) {
      const [noteId, updatedAt] = this.fetchQueue.entries().next().value!;
      this.fetchQueue.delete(noteId);
      this.fetching++;
      void this.client
        .query(api.notes.content, { noteId: noteId as Id<"notes"> })
        .then(async (content) => {
          if (!content || this.state.accountId !== accountId) return;
          if (
            (await this.store.bodyRevision(accountId, noteId)) ===
            content.revision
          )
            return;
          const doc = parseStoredDoc(content.doc);
          const fence = await this.store.captureFence(accountId);
          await this.store.cacheAccepted(
            {
              accountId,
              id: noteId,
              document: content.doc,
              text: plainText(doc),
              revision: content.revision,
            },
            updatedAt,
            fence,
          );
        })
        .catch(() => undefined)
        .finally(() => {
          this.fetching--;
          this.pump(accountId);
        });
    }
  }

  /** Create local notes written before the server was reachable. */
  async syncDrafts() {
    const accountId = this.state.accountId;
    if (!accountId || !this.state.ready || this.syncingDrafts) return;
    this.syncingDrafts = true;
    try {
      for (const draft of await this.store.localDrafts(accountId)) {
        if (this.openNotes.has(draft.id) || this.state.accountId !== accountId)
          continue;
        // The local ID is the creation key: retries return the same note.
        const created = await this.client.mutation(api.notes.create, {
          clientKey: draft.id.slice(0, 64),
          doc: draft.document,
          ...(draft.notebookId
            ? { notebookId: draft.notebookId as Id<"notebooks"> }
            : {}),
          deviceTime: draft.updatedAt,
        });
        const fence = await this.store.captureFence(accountId);
        // Adoption marks the draft created, so it is never created again.
        await this.store.adoptServerId(
          accountId,
          draft.id,
          created.noteId,
          fence,
        );
      }
      for (const draft of await this.store.adoptedDrafts(accountId)) {
        if (this.openNotes.has(draft.id) || this.state.accountId !== accountId)
          continue;
        try {
          await this.reconcileCreated(accountId, draft.id, draft);
          this.queueFetch(accountId, draft.id, draft.updatedAt);
        } catch {
          /* this draft waits for the next sync; others continue */
        }
      }
    } catch {
      /* retried on the next connection or close of the open draft */
    } finally {
      this.syncingDrafts = false;
    }
  }

  /**
   * A creation may have been answered from an earlier attempt. Compare the
   * note's creation version (revision 0) with the local draft and keep any
   * difference as an ordinary collaborative edit on that base: the editor's
   * rebasing then preserves edits others made since, and a fixed client ID
   * makes a resent step recognizable if an earlier send was accepted.
   */
  private async reconcileCreated(
    accountId: string,
    noteId: string,
    draft: Draft,
  ) {
    const origin = await this.client.query(api.history.read, {
      noteId: noteId as Id<"notes">,
      revision: 0,
    });
    if (this.state.accountId !== accountId) return;
    const base = parseStoredDoc(origin.doc);
    const local = parseStoredDoc(draft.document);
    if (sameContent(base, local)) {
      // Nothing local beyond creation: the server's current note is the truth.
      const content = await this.client.query(api.notes.content, {
        noteId: noteId as Id<"notes">,
      });
      if (!content) return;
      const fence = await this.store.captureFence(accountId);
      await this.store.settleDraft(
        accountId,
        noteId,
        {
          accountId,
          id: noteId,
          document: content.doc,
          text: plainText(parseStoredDoc(content.doc)),
          revision: content.revision,
        },
        draft.updatedAt,
        draft,
        fence,
      );
      return;
    }
    const step = diffStep(base, local);
    if (!step) return;
    const clientId = draft.clientId ?? crypto.randomUUID().replace(/-/g, "");
    const journal: Draft = {
      ...draft,
      baseDocument: origin.doc,
      baseRevision: 0,
      steps: [JSON.stringify(step.toJSON())],
      clientId,
      created: true,
    };
    // Journal before sending, with the identity the send will use.
    await this.store.writeDraft(journal);
    try {
      const pushed = await this.client.mutation(api.notes.push, {
        noteId: noteId as Id<"notes">,
        revision: 0,
        steps: journal.steps!,
        clientId,
      });
      if (pushed.status !== "accepted") return; // Others edited; the editor rebases on open.
      const content = await this.client.query(api.notes.content, {
        noteId: noteId as Id<"notes">,
      });
      if (!content) return;
      const fence = await this.store.captureFence(accountId);
      await this.store.settleDraft(
        accountId,
        noteId,
        {
          accountId,
          id: noteId,
          document: content.doc,
          text: plainText(parseStoredDoc(content.doc)),
          revision: content.revision,
        },
        journal.updatedAt,
        journal,
        fence,
      );
    } catch {
      /* the journal stays; opening the note resends with the same client ID */
    }
  }

  setOpen(noteId: string, open: boolean) {
    if (open) this.openNotes.add(noteId);
    else {
      this.openNotes.delete(noteId);
      void this.syncDrafts();
    }
  }

  readonly transport: NoteTransport = {
    create: async (args) => {
      try {
        return await this.client.mutation(api.notes.create, {
          clientKey: args.clientKey.slice(0, 64),
          doc: args.doc,
          ...(args.notebookId
            ? { notebookId: args.notebookId as Id<"notebooks"> }
            : {}),
        });
      } catch (error) {
        throw transportError(error);
      }
    },
    push: async (args) => {
      try {
        return await this.client.mutation(api.notes.push, {
          noteId: args.noteId as Id<"notes">,
          revision: args.revision,
          steps: args.steps,
          clientId: args.clientId,
        });
      } catch (error) {
        throw transportError(error);
      }
    },
    subscribeSteps: (noteId, after, onBatch, onError) =>
      this.watch(
        api.notes.steps,
        { noteId: noteId as Id<"notes">, after },
        (batch) => onBatch(batch as StepBatch),
        (error) => onError(transportError(error)),
      ),
  };

  subscribeContent(
    noteId: string,
    onContent: (content: FunctionReturnType<typeof api.notes.content>) => void,
  ) {
    return this.watch(
      api.notes.content,
      { noteId: noteId as Id<"notes"> },
      onContent,
    );
  }

  async fetchContent(noteId: string) {
    return this.client.query(api.notes.content, {
      noteId: noteId as Id<"notes">,
    });
  }

  async search(query: string): Promise<SearchHit[]> {
    return this.client.query(api.library.search, { query, limit: 30 });
  }

  async deleteForever(noteId: string) {
    try {
      await this.client.mutation(api.lifecycle.deleteForever, {
        noteId: noteId as Id<"notes">,
      });
    } catch (error) {
      throw transportError(error);
    }
  }

  async trash(noteId: string, trashed: boolean) {
    try {
      await this.client.mutation(
        trashed ? api.notes.trash : api.notes.restore,
        {
          noteId: noteId as Id<"notes">,
        },
      );
    } catch (error) {
      throw transportError(error);
    }
  }
}

export function createLive(
  convexURL: string,
  auth: Auth,
  store: NotesStore,
  session: SessionController,
) {
  return new LiveController(convexURL, auth, store, session);
}
