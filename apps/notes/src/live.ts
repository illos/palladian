import {
  diffStep,
  diffSteps,
  parseStoredDoc,
} from "@palladian/notes-core/document";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import { plainText } from "@palladian/notes-core/projection";
import { api } from "@palladian/notes-backend/api";
import { ConvexReactClient } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { Id } from "@palladian/notes-backend/dataModel";
import type { CacheFence, Draft, RemoteSummary, NotesStore } from "./cache";
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

/** The server's limit on steps in one send. */
const MAX_STEPS_PER_SEND = 500;

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
    // Held notes wait for the server's answer, including after a failed check.
    const held = await this.store.heldMarkers(accountId);
    void this.recheckAccess(accountId, [
      ...new Set([...fenced, ...held.keys()]),
    ]);
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
   * be older than the revocation, or are held while access is in doubt. Ask the
   * server through a mutation, which no local subscription can answer. Act on
   * a fence only if its marker is unchanged since before the request and the
   * answer is for this account: access lifts it, and a denial removes the work
   * a held fence kept.
   */
  private async recheckAccess(accountId: string, ids: string[]) {
    if (!ids.length) return;
    let fence: CacheFence;
    let markers: Map<string, string>;
    let held: Map<string, string>;
    try {
      fence = await this.store.captureFence(accountId);
      markers = await this.store.revocationMarkers(accountId, ids);
      held = await this.store.heldMarkers(accountId);
    } catch {
      return;
    }
    for (const [id, marker] of markers) {
      let verdict;
      try {
        verdict = await this.client.mutation(api.notes.verifyAccess, {
          noteId: id as Id<"notes">,
        });
      } catch {
        continue;
      }
      if (verdict.subject !== accountId || this.state.accountId !== accountId)
        continue;
      if (!verdict.summary) {
        if (held.get(id) === marker)
          await this.store
            .purgeHeld(accountId, [{ id, marker }], fence)
            .catch(() => undefined);
        continue;
      }
      try {
        await this.store.allowNotes(accountId, [{ id, marker }], fence);
        const still = await this.store.cacheSummaries(
          accountId,
          [toRemote(verdict.summary)],
          [],
          fence,
        );
        if (!still.length)
          this.queueFetch(accountId, id, verdict.summary.editedAt);
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
      await this.createLocalDrafts(accountId);
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
      // Reconciliation may have kept a conflicting version as a new draft.
      await this.createLocalDrafts(accountId);
    } catch {
      /* retried on the next connection or close of the open draft */
    } finally {
      this.syncingDrafts = false;
    }
  }

  private async createLocalDrafts(accountId: string) {
    for (const draft of await this.store.localDrafts(accountId)) {
      if (this.openNotes.has(draft.id) || this.state.accountId !== accountId)
        continue;
      try {
        await this.createLocalDraft(accountId, draft);
      } catch {
        /* this draft waits for the next sync; others continue */
      }
    }
  }

  private async createLocalDraft(accountId: string, draft: Draft) {
    if (draft.source) {
      // A conflict copy holds its source note's content: it becomes a note only
      // while the source is accessible, and goes with the source otherwise.
      const verdict = await this.client.mutation(api.notes.verifyAccess, {
        noteId: draft.source as Id<"notes">,
      });
      if (verdict.subject !== accountId || this.state.accountId !== accountId)
        return;
      if (!verdict.summary)
        return this.store.revokeNotes(accountId, [draft.source]);
    }
    // The local ID is the creation key: retries return the same note.
    const created = await this.client.mutation(api.notes.create, {
      clientKey: draft.id.slice(0, 64),
      doc: draft.document,
      ...(draft.notebookId
        ? { notebookId: draft.notebookId as Id<"notebooks"> }
        : {}),
      ...(draft.source ? { sourceNoteId: draft.source as Id<"notes"> } : {}),
      deviceTime: draft.updatedAt,
    });
    const fence = await this.store.captureFence(accountId);
    // Adoption marks the draft created, so it is never created again.
    await this.store.adoptServerId(accountId, draft.id, created.noteId, fence);
  }

  /**
   * A creation may have been answered from an earlier attempt, so the server's
   * note can lag the local draft. A saved draft says what the note became, not
   * how it was edited, so its difference is never rebased over anyone else's
   * edits. While every change since creation came from this recovery, the
   * difference is sent against the server's current revision, and the server
   * accepts it only if that is still current. Once someone else has changed the
   * note, both versions are kept. A fixed client ID recognizes this recovery's
   * own earlier sends, including one whose reply was lost. Nothing replaces
   * newer local typing, and an open note is left to its editor.
   */
  private async reconcileCreated(
    accountId: string,
    noteId: string,
    draft: Draft,
  ) {
    await this.store.withRecoveryLock(accountId, noteId, () =>
      this.recoverCreated(accountId, noteId, draft),
    );
  }

  private async recoverCreated(
    accountId: string,
    noteId: string,
    draft: Draft,
  ) {
    const id = noteId as Id<"notes">;
    const content = await this.client.query(api.notes.content, { noteId: id });
    if (!content || this.state.accountId !== accountId) return;
    const current = parseStoredDoc(content.doc);
    const local = parseStoredDoc(draft.document);
    if (sameContent(current, local))
      return this.settleCreated(accountId, noteId, content, draft);
    const clientId = draft.clientId ?? crypto.randomUUID().replace(/-/g, "");
    const own =
      content.role !== "read" &&
      (await this.onlyOwnSteps(id, clientId, content.revision));
    if (this.state.accountId !== accountId) return;
    if (!own) {
      if (content.role !== "read") {
        const origin = await this.client.query(api.history.read, {
          noteId: id,
          revision: 0,
        });
        if (this.state.accountId !== accountId) return;
        // Nothing local beyond creation: the server's note is the truth.
        if (sameContent(parseStoredDoc(origin.doc), local))
          return this.settleCreated(accountId, noteId, content, draft);
      }
      if (this.openNotes.has(noteId)) return;
      const fence = await this.store.captureFence(accountId);
      await this.store.splitConflict(
        draft,
        "local-" + crypto.randomUUID().replace(/-/g, ""),
        {
          accountId,
          id: noteId,
          document: content.doc,
          text: plainText(current),
          revision: content.revision,
        },
        fence,
      );
      return;
    }
    let steps = diffSteps(current, local);
    if (!steps || steps.length > MAX_STEPS_PER_SEND)
      steps = [diffStep(current, local)!];
    // Send only while this exact draft is still saved and its note closed,
    // recording the client ID first so a lost reply is recognized.
    const sending: Draft = { ...draft, clientId };
    if (
      this.openNotes.has(noteId) ||
      !(await this.store.replaceDraftIf(draft, sending)) ||
      this.openNotes.has(noteId) ||
      this.state.accountId !== accountId
    )
      return;
    const pushed = await this.client.mutation(api.notes.push, {
      noteId: id,
      revision: content.revision,
      steps: steps.map((step) => JSON.stringify(step.toJSON())),
      clientId,
    });
    // Someone else changed the note first; the next sync keeps both versions.
    if (pushed.status !== "accepted") return;
    const saved = await this.client.query(api.notes.content, { noteId: id });
    if (!saved || this.state.accountId !== accountId) return;
    await this.settleCreated(accountId, noteId, saved, sending);
  }

  /**
   * Whether every change after creation, up to `revision`, was sent with
   * `clientId`. The server's ID repairs directly follow the send they repair.
   */
  private async onlyOwnSteps(
    noteId: Id<"notes">,
    clientId: string,
    revision: number,
  ) {
    let after = 0;
    while (after < revision) {
      const batch = await this.client.query(api.notes.steps, {
        noteId,
        after,
      });
      if (!batch.steps.length) return false;
      for (const step of batch.steps.slice(0, revision - after))
        if (step.clientId !== clientId && step.clientId !== "server")
          return false;
      after += batch.steps.length;
    }
    return true;
  }

  /**
   * The server's note is current for this draft: cache it and retire the
   * draft. An open note is settled by the sync after it closes.
   */
  private async settleCreated(
    accountId: string,
    noteId: string,
    content: { doc: string; revision: number },
    expected: Draft,
  ) {
    if (this.openNotes.has(noteId)) return;
    const fence = await this.store.captureFence(accountId);
    if (this.openNotes.has(noteId)) return;
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
      expected.updatedAt,
      expected,
      fence,
    );
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
