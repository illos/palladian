import type { FileNoteUpload } from "./file-notes";

/**
 * File notes being made from the list (plan 08 B4; review round 1, F3 and
 * F4). Each file the person chooses or drops is one operation:
 *
 * - `creating`: `notes.create` is on its way with the operation's creation
 *   key;
 * - `unanswered`: it went without an answer (a lost response, a dropped
 *   connection), so the note may or may not exist. The key is kept: Retry,
 *   or choosing the same file again, sends the same key, and the server
 *   returns the note it already made instead of making a second (A4's rule
 *   for copies). Remove gives the operation up;
 * - `made`: the note exists, and the file waits, for at most `waitMs`, for
 *   that note's editor. Only an editor showing that note takes it, so files
 *   dropped one after another each reach their own note.
 *
 * A file whose operation is creating or made is not sent again. Operations
 * belong to the account and session generation they began in, and live in
 * this page's memory only.
 */
export type FileNoteState = "creating" | "unanswered" | "made";

export interface FileNoteOperation {
  readonly id: string;
  readonly accountId: string;
  readonly generation: number;
  readonly title: string;
  /** The new note's document: its title line. */
  readonly document: string;
  readonly notebookId: string | undefined;
  /** Sent with every attempt, until the server answers. */
  readonly key: string;
  readonly state: FileNoteState;
  /** Why the last attempt has no answer. */
  readonly message: string | null;
  /** The note, once made. */
  readonly noteId: string | null;
}

interface Entry {
  operation: FileNoteOperation;
  file: File;
  /** The file, as `sameFile` tells it apart. */
  same: string;
  /** For the note's editor, once made. */
  upload: FileNoteUpload | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** How long a made note's file waits for that note's editor. */
export const FILE_NOTE_WAIT_MS = 20_000;

/**
 * A file, as told apart from others chosen in the same session: by name,
 * size and type (choosing it again need not give the same modification
 * time).
 */
const sameFile = (accountId: string, generation: number, file: File) =>
  [accountId, generation, file.name, file.size, file.type]
    .map(String)
    .join("\n");

export class FileNoteOperations {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private changes = 0;

  constructor(
    private readonly options: {
      /** A made note's file was not taken in time, or files turned off. */
      lost: (operation: FileNoteOperation) => void;
      waitMs?: number;
      newKey?: () => string;
    },
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  /** Changes whenever an operation does (for `useSyncExternalStore`). */
  version = () => this.changes;

  /** The operations of one account and session generation, oldest first. */
  list(accountId: string | null, generation: number): FileNoteOperation[] {
    return [...this.entries.values()]
      .map((entry) => entry.operation)
      .filter(
        (operation) =>
          operation.accountId === accountId &&
          operation.generation === generation,
      );
  }

  /**
   * Begin an operation for `file`, or retry the one this file already has
   * without an answer (same key). `duplicate` when the file's operation is
   * on its way or its note waits for it: nothing is to be sent.
   */
  begin(
    scope: { accountId: string; generation: number },
    file: File,
    note: { title: string; document: string; notebookId: string | undefined },
  ): { send: FileNoteOperation } | { duplicate: FileNoteOperation } {
    const same = sameFile(scope.accountId, scope.generation, file);
    const existing = [...this.entries.values()].find(
      (entry) => entry.same === same,
    );
    if (existing) {
      const retried = this.retry(existing.operation.id);
      return retried ? { send: retried } : { duplicate: existing.operation };
    }
    const operation: FileNoteOperation = {
      id: crypto.randomUUID(),
      accountId: scope.accountId,
      generation: scope.generation,
      title: note.title,
      document: note.document,
      notebookId: note.notebookId,
      key: (this.options.newKey ?? (() => "file-" + crypto.randomUUID()))(),
      state: "creating",
      message: null,
      noteId: null,
    };
    this.entries.set(operation.id, {
      operation,
      file,
      same,
      upload: null,
      timer: null,
    });
    this.changed();
    return { send: operation };
  }

  /** Send an unanswered operation again, with its key; null otherwise. */
  retry(id: string): FileNoteOperation | null {
    const entry = this.entries.get(id);
    if (entry?.operation.state !== "unanswered") return null;
    return this.update(entry, { state: "creating", message: null });
  }

  /** No answer: keep the key for a retry. */
  unanswered(id: string, message: string) {
    const entry = this.entries.get(id);
    if (entry?.operation.state === "creating")
      this.update(entry, { state: "unanswered", message });
  }

  /**
   * The server made the note: its file waits for that note's editor. False
   * if the operation is gone (removed, files off, another session): the
   * caller does not open the note.
   */
  made(id: string, noteId: string): boolean {
    const entry = this.entries.get(id);
    if (entry?.operation.state !== "creating") return false;
    const operation = this.update(entry, { state: "made", noteId });
    let waiting: File | null = entry.file;
    entry.upload = {
      accountId: operation.accountId,
      generation: operation.generation,
      noteId,
      title: operation.title,
      // Once only, and never after the operation ended (removed, timed
      // out, files off, another session).
      take: () => {
        if (!this.entries.has(id)) return null;
        const taken = waiting;
        waiting = null;
        if (taken) this.end(id);
        return taken;
      },
    };
    entry.timer = setTimeout(() => {
      if (!this.entries.has(id)) return;
      this.end(id);
      this.options.lost(operation);
    }, this.options.waitMs ?? FILE_NOTE_WAIT_MS);
    return true;
  }

  /** Given up: refused by the server, or removed by the person. */
  remove(id: string) {
    this.end(id);
  }

  /** The file waiting for this note's editor, in this account and generation. */
  uploadFor(
    accountId: string,
    generation: number,
    noteId: string,
  ): FileNoteUpload | undefined {
    for (const entry of this.entries.values())
      if (
        entry.upload &&
        entry.upload.noteId === noteId &&
        entry.upload.accountId === accountId &&
        entry.upload.generation === generation
      )
        return entry.upload;
    return undefined;
  }

  /** Keep only this account and generation's operations; the rest end quietly. */
  follow(accountId: string | null, generation: number) {
    for (const entry of [...this.entries.values()])
      if (
        entry.operation.accountId !== accountId ||
        entry.operation.generation !== generation
      )
        this.end(entry.operation.id);
  }

  /** Files turned off: every operation ends; each is reported. */
  clear() {
    for (const entry of [...this.entries.values()]) {
      this.end(entry.operation.id);
      this.options.lost(entry.operation);
    }
  }

  private update(entry: Entry, change: Partial<FileNoteOperation>) {
    entry.operation = { ...entry.operation, ...change };
    this.changed();
    return entry.operation;
  }

  private end(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
    this.changed();
  }

  private changed() {
    this.changes++;
    for (const listener of [...this.listeners]) listener();
  }
}
