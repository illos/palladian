import { parseStoredDoc } from "@palladian/notes-core/document";
import { notesSchema } from "@palladian/notes-core/schema";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  getVersion,
  receiveTransaction,
  sendableSteps,
} from "prosemirror-collab";
import type { Transaction } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import type { EditorBinding } from "./binding";
import type { Draft, NotesStore } from "./cache";

export interface StepBatch {
  from: number;
  steps: { step: string; clientId: string }[];
  more: boolean;
}
export class TransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
/** Server operations a note channel needs; implemented by the deferred live module. */
export interface NoteTransport {
  create(args: {
    clientKey: string;
    doc: string;
    notebookId?: string;
  }): Promise<{ noteId: string; revision: number }>;
  push(args: {
    noteId: string;
    revision: number;
    steps: string[];
    clientId: string;
  }): Promise<{ status: "accepted" | "behind"; revision: number }>;
  subscribeSteps(
    noteId: string,
    after: number,
    onBatch: (batch: StepBatch) => void,
    onError: (error: TransportError) => void,
  ): () => void;
}

export type ChannelStatus =
  | { kind: "offline"; pending: boolean }
  | { kind: "syncing" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "blocked"; code: string; message: string };

export interface ChannelOptions {
  store: NotesStore;
  accountId: string;
  /** Server note ID, or the local ID of a note not yet created. */
  noteId: string;
  created: boolean;
  notebookId?: string;
  baseDocument: string;
  baseRevision: number;
  clientId: string;
  pending: string[];
  onStatus: (status: ChannelStatus) => void;
  onCreated?: (noteId: string) => void;
  onAccessLost?: (noteId: string) => void;
}

const JOURNAL_DELAY_MS = 200;

/**
 * One open collaborative note. Unconfirmed steps are journaled locally until
 * the server's step feed echoes them back with this client's ID, so a lost
 * response, reload or disconnect never duplicates or drops accepted edits.
 */
export class NoteChannel implements EditorBinding {
  readonly version: number;
  readonly clientId: string;
  readonly pending: string[];
  private readonly options: ChannelOptions;
  private noteId: string;
  private created: boolean;
  private view: EditorView | null = null;
  private transport: NoteTransport | null = null;
  private confirmed: ProseMirrorNode;
  private unsubscribe: (() => void) | null = null;
  private inflight = false;
  private caughtUp = false;
  private blocked: ChannelStatus | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private journalTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private journaled: Draft | null = null;
  private closed = false;

  constructor(options: ChannelOptions) {
    this.options = options;
    this.noteId = options.noteId;
    this.created = options.created;
    this.version = options.baseRevision;
    this.clientId = options.clientId;
    this.pending = options.pending;
    this.confirmed = parseStoredDoc(options.baseDocument);
  }

  get id() {
    return this.noteId;
  }
  /** Editing is allowed once the editor has caught up with the server, or for new notes. */
  get ready() {
    return !this.blocked && (!this.created || this.caughtUp);
  }

  /** What the editor shows now, including typing not yet saved anywhere. */
  current(): { document: string; text: string } | null {
    const doc = this.view?.state.doc;
    if (!doc) return null;
    return {
      document: JSON.stringify(doc.toJSON()),
      text: doc.textBetween(0, doc.content.size, "\n"),
    };
  }

  attach(view: EditorView) {
    this.view = view;
    if (this.transport) this.start();
    else this.report();
    return () => {
      this.flushJournal();
      this.stop();
      this.view = null;
    };
  }

  connect(transport: NoteTransport | null) {
    if (this.transport === transport) return;
    this.stop();
    this.transport = transport;
    if (this.view && transport) this.start();
    else this.report();
  }

  close() {
    this.closed = true;
    this.flushJournal();
    this.stop();
  }

  changed(view: EditorView, tr: Transaction) {
    if (!tr.docChanged || tr.getMeta("rebased") !== undefined) return;
    this.view = view;
    this.scheduleJournal();
    if (!this.created) this.start();
    else this.trySend();
    this.report();
  }

  private start() {
    if (!this.view || !this.transport || this.closed || this.blocked) return;
    if (!this.created) {
      // An untouched new note is not created on the server.
      if (this.view && sendableSteps(this.view.state)) void this.createRemote();
      else this.report();
      return;
    }
    this.subscribe();
    this.trySend();
  }

  private stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.caughtUp = false;
  }

  private async createRemote() {
    const transport = this.transport;
    if (!transport || this.inflight) return;
    this.inflight = true;
    this.report();
    try {
      const result = await transport.create({
        clientKey: this.noteId,
        doc: JSON.stringify(this.confirmed.toJSON()),
        ...(this.options.notebookId
          ? { notebookId: this.options.notebookId }
          : {}),
      });
      if (this.transport !== transport || this.closed) return;
      const fence = await this.options.store.captureFence(
        this.options.accountId,
      );
      await this.options.store.adoptServerId(
        this.options.accountId,
        this.noteId,
        result.noteId,
        fence,
      );
      this.noteId = result.noteId;
      this.created = true;
      this.failures = 0;
      this.options.onCreated?.(result.noteId);
      this.inflight = false;
      this.scheduleJournal();
      this.start();
    } catch (error) {
      this.inflight = false;
      this.handleError(error);
    }
  }

  private subscribe() {
    const transport = this.transport;
    const view = this.view;
    if (!transport || !view) return;
    this.unsubscribe?.();
    const after = getVersion(view.state);
    this.unsubscribe = transport.subscribeSteps(
      this.noteId,
      after,
      (batch) => this.receive(batch),
      (error) => this.handleError(error),
    );
  }

  private receive(batch: StepBatch) {
    const view = this.view;
    if (!view || this.closed) return;
    if (batch.from !== getVersion(view.state)) return;
    if (batch.steps.length) {
      const steps = batch.steps.map((s) =>
        Step.fromJSON(notesSchema, JSON.parse(s.step)),
      );
      for (const step of steps) {
        const result = step.apply(this.confirmed);
        if (!result.doc) {
          this.block(
            "invalid",
            "This note could not be synchronized. Reload to continue.",
          );
          return;
        }
        this.confirmed = result.doc;
      }
      view.dispatch(
        receiveTransaction(
          view.state,
          steps,
          batch.steps.map((s) => s.clientId),
          { mapSelectionBackward: true },
        ),
      );
    }
    this.failures = 0;
    this.caughtUp = !batch.more;
    if (batch.steps.length) {
      this.subscribe();
      this.scheduleJournal();
    }
    this.trySend();
    this.report();
  }

  private trySend() {
    const view = this.view;
    const transport = this.transport;
    if (!view || !transport || !this.created || this.inflight || this.blocked)
      return;
    if (!this.caughtUp) return;
    const sendable = sendableSteps(view.state);
    if (!sendable) return;
    this.inflight = true;
    this.report();
    const sentVersion = sendable.version;
    transport
      .push({
        noteId: this.noteId,
        revision: sentVersion,
        steps: sendable.steps.map((step) => JSON.stringify(step.toJSON())),
        clientId: this.clientId,
      })
      .then((result) => {
        // Accepted steps come back through the feed; "behind" waits for it too.
        // If the feed already advanced while this request was in flight, send again now.
        this.inflight = false;
        this.failures = 0;
        const current = this.view ? getVersion(this.view.state) : sentVersion;
        if (current !== sentVersion || result.status === "accepted")
          this.trySend();
        this.report();
      })
      .catch((error: unknown) => {
        this.inflight = false;
        this.handleError(error);
      });
  }

  private handleError(error: unknown) {
    const code = error instanceof TransportError ? error.code : "transient";
    if (code === "not_found" || code === "denied") {
      this.block(code, "You no longer have edit access to this note.");
      this.options.onAccessLost?.(this.noteId);
      return;
    }
    if (code === "trashed") {
      this.block(code, "This note is in Trash. Restore it to keep editing.");
      return;
    }
    if (code === "invalid" || code === "too_large") {
      this.block(
        code,
        error instanceof Error
          ? error.message
          : "This change could not be saved.",
      );
      return;
    }
    // Transient: keep journaled work and retry with backoff.
    this.failures++;
    this.report();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.start();
      },
      Math.min(30_000, 500 * 2 ** Math.min(this.failures, 6)),
    );
  }

  private block(code: string, message: string) {
    this.blocked = { kind: "blocked", code, message };
    this.stop();
    this.report();
  }

  private scheduleJournal() {
    if (this.journalTimer) return;
    this.journalTimer = setTimeout(() => {
      this.journalTimer = null;
      void this.writeJournal();
    }, JOURNAL_DELAY_MS);
  }

  private flushJournal() {
    if (!this.journalTimer) return;
    clearTimeout(this.journalTimer);
    this.journalTimer = null;
    void this.writeJournal();
  }

  /** Persist unconfirmed work, or retire the journal once everything is accepted. */
  private async writeJournal() {
    const view = this.view;
    if (!view || this.blocked?.kind === "blocked") return;
    const { store, accountId } = this.options;
    const sendable = sendableSteps(view.state);
    const doc = view.state.doc;
    const text = doc.textBetween(0, doc.content.size, "\n");
    try {
      if (!sendable && !this.created) return;
      if (sendable) {
        const draft: Draft = {
          accountId,
          id: this.noteId,
          document: JSON.stringify(doc.toJSON()),
          text,
          updatedAt: Date.now(),
          baseDocument: JSON.stringify(this.confirmed.toJSON()),
          baseRevision: getVersion(view.state),
          steps: sendable
            ? sendable.steps.map((s) => JSON.stringify(s.toJSON()))
            : [],
          clientId: this.clientId,
          created: this.created,
          ...(this.options.notebookId
            ? { notebookId: this.options.notebookId }
            : {}),
        };
        this.journaled = draft;
        await store.writeDraft(draft);
      } else {
        const fence = await store.captureFence(accountId);
        const confirmed = this.confirmed;
        await store.settleDraft(
          accountId,
          this.noteId,
          {
            accountId,
            id: this.noteId,
            document: JSON.stringify(confirmed.toJSON()),
            text: confirmed.textBetween(0, confirmed.content.size, "\n"),
            revision: getVersion(view.state),
          },
          Date.now(),
          this.journaled,
          fence,
        );
        this.journaled = null;
      }
    } catch {
      this.options.onStatus({
        kind: "blocked",
        code: "storage",
        message:
          "Local storage failed. Your latest typing is visible but may be lost if this window closes.",
      });
    }
  }

  private report() {
    if (this.blocked) {
      this.options.onStatus(this.blocked);
      return;
    }
    const view = this.view;
    const pending = !!view && !!sendableSteps(view.state);
    if (!this.transport || this.failures > 0) {
      this.options.onStatus({
        kind: "offline",
        pending: pending || !this.created,
      });
      return;
    }
    if (!this.created && !pending) {
      this.options.onStatus({ kind: "saved" });
      return;
    }
    if (!this.created || !this.caughtUp) {
      this.options.onStatus({ kind: "syncing" });
      return;
    }
    this.options.onStatus(
      pending || this.inflight ? { kind: "saving" } : { kind: "saved" },
    );
  }
}
