import {
  attachmentIds,
  stepAttachmentIds,
} from "@palladian/notes-core/attachments";
import { assignBlockIds } from "@palladian/notes-core/ids";
import { attachmentSource, notesSchema } from "@palladian/notes-core/schema";
import { getVersion, sendableSteps } from "prosemirror-collab";
import { closeHistory } from "prosemirror-history";
import type { Node as ProseMirrorNode, NodeType } from "prosemirror-model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type PluginView,
  type Transaction,
} from "prosemirror-state";
import { insertPoint } from "prosemirror-transform";
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeViewConstructor,
} from "prosemirror-view";
import type { AttachmentCache } from "./attachment-cache";
import {
  ADMISSION_WAIT_MS,
  AttachmentReadError,
  displayType,
  INLINE_IMAGE_TYPES,
  MAX_FILE_BYTES,
  MAX_NOTE_ATTACHMENTS,
  putAttachment,
  readAttachment,
  sha256Hex,
  UploadError,
  uploadRefusal,
  type AttachmentContext,
  type AttachmentService,
  type UploadGrant,
} from "./attachments";
import { fileWritesEnabled } from "./file-capability";
import { FileView, ImageView } from "./attachment-views";
import "./attachments.css";

/**
 * Inline attachments in the editor (plan 08 B3).
 *
 * Uploads are decorations, never document content: collaborators see nothing
 * until the object is ready, and then one ordinary step inserts the image or
 * file block where the upload's mark has been mapped to by everything typed
 * meanwhile, here or by others. Closing the note cancels its unfinished
 * uploads; the server fails or deletes the objects and sweeps their bytes.
 *
 * Images and file blocks are drawn by node views (attachment-views.ts) that
 * load bytes through the per-account cache (attachment-cache.ts) and the
 * Worker. A reference the server does not list for the note
 * (`files.noteObjects`: it grants nothing, or the object was permanently
 * deleted) shows "Attachment unavailable".
 */

const { image, file: fileNode } = notesSchema.nodes as Record<string, NodeType>;

/** Uploads run two at a time; the rest wait their turn. */
const PARALLEL_UPLOADS = 2;
/** How long an upload waits for a new note to reach the server. */
const NOTE_WAIT_MS = 15_000;

// ---------------------------------------------------------------------------
// Upload marks: where each unfinished upload will land.

export interface UploadMark {
  id: string;
  /** A position between blocks, mapped through every change. */
  pos: number;
  /** Start order: uploads at one position land in the order they began. */
  seq: number;
}
interface UploadsState {
  marks: UploadMark[];
  decorations: DecorationSet;
}
type UploadsMeta =
  { add: UploadMark[] } | { remove: string } | { inserted: string };

export const uploadsKey = new PluginKey<UploadsState>("uploads");

export function uploadMarks(state: EditorState): UploadMark[] {
  return uploadsKey.getState(state)?.marks ?? [];
}

/**
 * The marks of unfinished uploads, drawn as widgets by `widget` (null draws
 * nothing). Marks keep to the content before them: text typed at a mark
 * lands after it, and when an upload lands, uploads begun later at the same
 * place stay after it.
 */
export function uploadsPlugin(
  widget: (id: string) => HTMLElement | null,
  view?: (view: EditorView) => PluginView,
): Plugin<UploadsState> {
  const draw = (doc: ProseMirrorNode, marks: UploadMark[]) =>
    marks.length
      ? DecorationSet.create(
          doc,
          marks.flatMap((mark) => {
            const dom = widget(mark.id);
            return dom
              ? [
                  Decoration.widget(mark.pos, dom, {
                    key: "upload-" + mark.id,
                    side: mark.seq - 1_000_000,
                    ignoreSelection: true,
                    stopEvent: () => true,
                  }),
                ]
              : [];
          }),
        )
      : DecorationSet.empty;
  return new Plugin<UploadsState>({
    key: uploadsKey,
    state: {
      init: () => ({ marks: [], decorations: DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(uploadsKey) as UploadsMeta | undefined;
        if (!meta && (!tr.docChanged || !value.marks.length)) return value;
        const inserted =
          meta && "inserted" in meta
            ? value.marks.find((mark) => mark.id === meta.inserted)
            : undefined;
        let marks = value.marks
          .filter((mark) => mark !== inserted)
          .map((mark) => ({
            ...mark,
            pos: tr.mapping.map(
              mark.pos,
              inserted && mark.seq > inserted.seq ? 1 : -1,
            ),
          }));
        if (meta && "add" in meta) marks = [...marks, ...meta.add];
        if (meta && "remove" in meta)
          marks = marks.filter((mark) => mark.id !== meta.remove);
        return { marks, decorations: draw(state.doc, marks) };
      },
    },
    props: {
      decorations: (state) => uploadsKey.getState(state)?.decorations ?? null,
    },
    ...(view ? { view } : {}),
  });
}

/**
 * Where an upload begun at `pos` lands: before an empty block or a block the
 * caret starts, otherwise after the block, and never before the first line,
 * which is the note's title (D46, D80).
 */
export function uploadPoint(doc: ProseMirrorNode, pos: number): number {
  const valid = (point: number) => insertPoint(doc, point, image!) === point;
  const titled = (point: number) =>
    point === 0 && doc.firstChild ? doc.firstChild.nodeSize : point;
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.parent.isTextblock && $pos.depth > 0) {
    const atStart = $pos.parent.content.size === 0 || $pos.parentOffset === 0;
    const candidates = atStart ? [$pos.before(), $pos.after()] : [$pos.after()];
    for (const candidate of candidates.map(titled))
      if (valid(candidate)) return candidate;
    return insertPoint(doc, titled($pos.after()), image!) ?? doc.content.size;
  }
  const point = titled($pos.pos);
  return valid(point)
    ? point
    : (insertPoint(doc, point, image!) ?? doc.content.size);
}

/** Add marks for new uploads at `pos` (no document change). */
export function addUploads(
  state: EditorState,
  marks: UploadMark[],
): Transaction {
  return state.tr.setMeta(uploadsKey, { add: marks } satisfies UploadsMeta);
}

/** Drop an upload's mark (no document change). */
export function removeUpload(state: EditorState, id: string): Transaction {
  return state.tr.setMeta(uploadsKey, { remove: id } satisfies UploadsMeta);
}

/**
 * Insert a finished upload's node at its mark, as one undoable step of its
 * own. Null if the mark is gone.
 */
export function insertUpload(
  state: EditorState,
  id: string,
  node: ProseMirrorNode,
): Transaction | null {
  const mark = uploadMarks(state).find((candidate) => candidate.id === id);
  if (!mark) return null;
  const tr = state.tr;
  const at = insertPoint(state.doc, mark.pos, node.type);
  if (at === null) tr.replaceRangeWith(mark.pos, mark.pos, node);
  else tr.insert(at, node);
  assignBlockIds(tr);
  return closeHistory(tr).setMeta(uploadsKey, {
    inserted: id,
  } satisfies UploadsMeta);
}

/** The node a finished upload becomes: an image for inline picture types. */
export function uploadedNode(grant: UploadGrant, size: number) {
  return INLINE_IMAGE_TYPES.has(grant.mimeType)
    ? image!.create({ src: attachmentSource(grant.objectId), alt: grant.name })
    : fileNode!.create({
        objectId: grant.objectId,
        name: grant.name,
        mimeType: grant.mimeType,
        size,
      });
}

/** Objects that unsent local steps bring in: the server cannot know them yet. */
export function unsentObjects(state: EditorState): Set<string> {
  const unsent = new Set<string>();
  for (const step of sendableSteps(state)?.steps ?? [])
    for (const objectId of stepAttachmentIds(step)) unsent.add(objectId);
  return unsent;
}

/**
 * Files to upload from a paste or drop. A clipboard that also holds text as
 * HTML (a selection copied from a document, which some apps add a picture
 * of) pastes as before; a copied picture alone, or files, upload.
 */
export function transferFiles(data: DataTransfer | null): File[] {
  const files = Array.from(data?.files ?? []);
  if (!files.length) return [];
  const html = data!.getData("text/html");
  if (
    html &&
    new DOMParser().parseFromString(html, "text/html").body.textContent?.trim()
  )
    return [];
  return files;
}

// ---------------------------------------------------------------------------
// Showing attachments.

/** What a node view shows for an object. */
export type ObjectStatus =
  "idle" | "loading" | "shown" | "offline" | "unavailable" | "failed";

export interface ObjectRecord {
  status: ObjectStatus;
  /** Loaded bytes, for pictures. */
  blob: Blob | null;
  /** Whether a node view wants the bytes (pictures), or only the status. */
  wanted: boolean;
  /**
   * Not readable through the note yet while an unsent change of ours brings
   * it in: the server's next list for the note decides.
   */
  deferred: boolean;
  attempt: number;
  /** Aborts the read under way. */
  abort: AbortController | null;
  listeners: Set<() => void>;
}

export interface LightboxImage {
  src: string;
  alt: string;
  /** The object shown, so the lightbox closes if it becomes unavailable. */
  objectId: string | null;
}

/** A file block's attributes. */
export interface FileInfo {
  objectId: string;
  name: string;
  mimeType: string;
  size: number | null;
}

/** Opens a file instead of downloading it, for one media type. */
export type FileOpener = (file: FileInfo, bytes: () => Promise<Blob>) => void;
const openers = new Map<string, FileOpener>();

/**
 * Register how a media type opens. B4's PDF reader registers
 * `application/pdf` here; until then every file, PDFs included, downloads.
 */
export function registerFileOpener(mimeType: string, opener: FileOpener) {
  openers.set(mimeType, opener);
  return () => void openers.delete(mimeType);
}

/** Whether a media type opens (B4's reader) rather than downloads. */
export function opensFile(mimeType: string) {
  return openers.has(mimeType);
}

export interface AttachmentHooks {
  /** The open note's attachments, as the app last rendered them. */
  context(): AttachmentContext | undefined;
  /** Whether this editor sends its changes to the server (a live note). */
  collaborative: boolean;
  cache: AttachmentCache;
  notify(message: string): void;
  openImage(image: LightboxImage): void;
  /** Close the lightbox: its picture became unavailable, or its session ended. */
  closeImage(): void;
}

/**
 * One editor's attachments: what its node views show, and its uploads.
 *
 * Every read of bytes is fenced (review round 1, F3): it counts only while
 * this editor is open, for the account and session generation it began
 * in, and while the server still lists the object for the note (checked
 * again once the bytes arrive). A read that stops counting is aborted and
 * changes nothing: no picture, no cache entry, no download.
 */
export class AttachmentRuntime {
  view: EditorView | null = null;
  readonly uploads: UploadController;
  private alive = true;
  private readonly records = new Map<string, ObjectRecord>();
  /** Objects the server lists for the note now; null while unknown. */
  private known: ReadonlySet<string> | null = null;
  private watching: {
    service: AttachmentContext["service"];
    noteId: string | null;
  } = { service: null, noteId: null };
  private stopWatching: (() => void) | null = null;
  /** The account and session generation reads last began under. */
  private session: { accountId: string; generation: number } | null = null;
  /** Downloads under way. */
  private readonly downloads = new Set<AbortController>();
  /** What the lightbox shows, while open. */
  private lightbox: { objectId: string | null } | null = null;

  constructor(readonly hooks: AttachmentHooks) {
    this.uploads = new UploadController(this);
  }

  context() {
    return this.hooks.context();
  }

  /** The editor plugin: upload marks, and the runtime's lifetime. */
  plugin(): Plugin {
    return uploadsPlugin(
      (id) => this.uploads.widget(id),
      (view) => {
        this.view = view;
        this.refresh();
        return {
          // The document or its unsent steps changed, an acknowledgement
          // included: what may show can change with them (F6).
          update: (next, previous) => {
            if (
              next.state.doc !== previous.doc ||
              (this.hooks.collaborative &&
                getVersion(next.state) !== getVersion(previous))
            )
              this.reconcile();
          },
          destroy: () => this.destroy(),
        };
      },
    );
  }

  nodeViews(): Record<string, NodeViewConstructor> {
    return {
      image: (node, view, getPos) => new ImageView(node, view, getPos, this),
      file: (node, view, getPos) => new FileView(node, view, getPos, this),
    };
  }

  /** Whether files may be added here now: "+ File", paste and drop. */
  canUpload(view = this.view): boolean {
    return (
      !!view &&
      view.editable &&
      this.hooks.collaborative &&
      fileWritesEnabled() &&
      !!this.context()?.service
    );
  }

  /** Files chosen with "+ File" land after the block the caret is in. */
  pick(files: File[]) {
    const view = this.view;
    if (!view || !files.length || !this.canUpload(view)) return;
    this.uploads.start(
      view,
      files,
      uploadPoint(view.state.doc, view.state.selection.to),
    );
  }

  /** The editor's `handlePaste`, for files; false leaves the paste as it was. */
  pasteFiles(view: EditorView, event: ClipboardEvent): boolean {
    if (!this.canUpload(view)) return false;
    const files = transferFiles(event.clipboardData);
    if (!files.length) return false;
    if (!view.state.selection.empty)
      view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    this.uploads.start(
      view,
      files,
      uploadPoint(view.state.doc, view.state.selection.from),
    );
    return true;
  }

  /** The editor's `handleDrop`, for files from outside the note. */
  dropFiles(view: EditorView, event: DragEvent, moved: boolean): boolean {
    if (moved || view.dragging || !this.canUpload(view)) return false;
    const files = transferFiles(event.dataTransfer);
    if (!files.length) return false;
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (!at) return false;
    this.uploads.start(view, files, uploadPoint(view.state.doc, at.pos));
    return true;
  }

  /**
   * The app's context changed (the note reached the server, the connection
   * came or went, the session moved on): follow the note's objects, drop
   * what was read under another session, and load what could not load.
   */
  refresh() {
    if (!this.alive) return;
    const context = this.context();
    const session = context
      ? { accountId: context.accountId, generation: context.generation }
      : null;
    if (
      session?.accountId !== this.session?.accountId ||
      session?.generation !== this.session?.generation
    ) {
      if (this.session) {
        for (const abort of this.downloads) abort.abort();
        this.downloads.clear();
        this.closeImage();
        for (const [objectId, record] of this.records) {
          this.invalidate(record);
          this.set(objectId, "idle");
        }
      }
      this.session = session;
    }
    const service = context?.service ?? null;
    const noteId = context?.noteId ?? null;
    if (service !== this.watching.service || noteId !== this.watching.noteId) {
      this.stopWatching?.();
      this.stopWatching = null;
      this.known = null;
      this.watching = { service, noteId };
      if (service && noteId)
        this.stopWatching = service.watchNoteObjects(noteId, (objects) =>
          this.setKnown(objects),
        );
    }
    for (const [objectId, record] of this.records)
      if (
        record.wanted &&
        (record.status === "offline" ||
          record.status === "failed" ||
          record.status === "idle")
      )
        void this.load(objectId);
  }

  destroy() {
    this.alive = false;
    for (const record of this.records.values()) this.invalidate(record);
    for (const abort of this.downloads) abort.abort();
    this.downloads.clear();
    this.uploads.destroy();
    this.stopWatching?.();
    this.stopWatching = null;
    this.records.clear();
    this.closeImage();
    this.view = null;
  }

  /**
   * Follow an object's status; `wantBytes` loads it for display, now or
   * once it becomes available (F5).
   */
  watch(objectId: string, listener: () => void, wantBytes: boolean) {
    let record = this.records.get(objectId);
    if (!record) {
      record = {
        status: "idle",
        blob: null,
        wanted: false,
        deferred: false,
        attempt: 0,
        abort: null,
        listeners: new Set(),
      };
      this.records.set(objectId, record);
    }
    record.listeners.add(listener);
    if (wantBytes) record.wanted = true;
    if (this.gone(objectId)) this.set(objectId, "unavailable");
    else if (record.wanted && record.status === "idle")
      void this.load(objectId);
    return () => {
      record.listeners.delete(listener);
      if (!record.listeners.size && this.records.get(objectId) === record) {
        this.invalidate(record);
        this.records.delete(objectId);
      }
    };
  }

  record(objectId: string): ObjectRecord | undefined {
    return this.records.get(objectId);
  }

  retry(objectId: string) {
    void this.load(objectId);
  }

  /** Show a picture full screen. */
  showImage(image: LightboxImage) {
    if (!this.alive) return;
    this.lightbox = { objectId: image.objectId };
    this.hooks.openImage(image);
  }

  /**
   * Open a file: its registered opener, or a download. Nothing happens if,
   * by the time its bytes arrive, the editor closed, the session moved on
   * or the object became unavailable. Throws AttachmentReadError.
   */
  async open(info: FileInfo): Promise<void> {
    const context = this.context();
    if (!context || !this.alive) throw new AttachmentReadError("signed-out");
    if (this.gone(info.objectId)) throw new AttachmentReadError("unavailable");
    const abort = new AbortController();
    const holds = this.fence(context);
    const current = () =>
      holds() && !abort.signal.aborted && !this.gone(info.objectId);
    const bytes = async () => {
      const blob = await this.fetchBytes(
        info.objectId,
        context,
        abort.signal,
        current,
      );
      if (!current()) throw new AttachmentReadError("unavailable");
      return blob;
    };
    const opener = openers.get(info.mimeType);
    if (opener) {
      opener(info, bytes);
      return;
    }
    this.downloads.add(abort);
    let blob: Blob;
    try {
      blob = await bytes();
    } catch (error) {
      if (!current()) return;
      throw error;
    } finally {
      this.downloads.delete(abort);
    }
    // Checked once more right before the download begins.
    if (!current()) return;
    // Always a plain download: the page never renders a file's bytes.
    const url = URL.createObjectURL(
      new Blob([blob], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = info.name;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** The server's list arrived. */
  private setKnown(objects: ReadonlySet<string> | null) {
    this.known = objects;
    this.reconcile();
  }

  /**
   * Recheck what each object may show against the server's list for the
   * note and our unsent steps (F5, F6): an object neither lists becomes
   * unavailable (its pending read is dropped and its cached bytes too); one
   * that is listed again, or that was waiting for the server, loads.
   */
  private reconcile() {
    const known = this.known;
    if (!known || !this.alive) return;
    const context = this.context();
    let unsent: Set<string> | null = null;
    for (const [objectId, record] of this.records) {
      const listed = known.has(objectId);
      if (!listed) {
        unsent ??= this.view ? unsentObjects(this.view.state) : new Set();
        if (unsent.has(objectId)) continue;
        if (record.status === "unavailable") continue;
        record.deferred = false;
        this.invalidate(record);
        if (context) void this.hooks.cache.drop(context.accountId, objectId);
        this.set(objectId, "unavailable");
      } else if (record.status === "unavailable" || record.deferred) {
        record.deferred = false;
        if (record.wanted) void this.load(objectId);
        else this.set(objectId, "idle");
      }
    }
  }

  /**
   * The Worker found nothing for this object through the note: unavailable,
   * unless an unsent change of ours brings it in (the server's next list
   * for the note decides).
   */
  private unreadable(objectId: string) {
    const record = this.records.get(objectId);
    if (!record) return;
    if (this.view && unsentObjects(this.view.state).has(objectId)) {
      record.deferred = true;
      this.set(objectId, record.wanted ? "loading" : "idle");
    } else this.set(objectId, "unavailable");
  }

  /**
   * Known not to be readable through this note: the server's list for the
   * note lacks it, and no unsent change of ours brings it in.
   */
  private gone(objectId: string) {
    return (
      this.known !== null &&
      !this.known.has(objectId) &&
      !(this.view && unsentObjects(this.view.state).has(objectId))
    );
  }

  /** Whether the editor, account and session generation a read began under still hold. */
  private fence(context: AttachmentContext): () => boolean {
    const { accountId, generation } = context;
    return () => {
      if (!this.alive) return false;
      const now = this.context();
      return (
        !!now && now.accountId === accountId && now.generation === generation
      );
    };
  }

  /** Stop an object's pending read; its result, if any, is ignored. */
  private invalidate(record: ObjectRecord) {
    record.attempt++;
    record.abort?.abort();
    record.abort = null;
  }

  /**
   * The object's bytes: cached, or read through the Worker. Bytes read are
   * cached only while `current()` holds and the object is still listed.
   */
  private async fetchBytes(
    objectId: string,
    context: AttachmentContext,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<Blob> {
    const { accountId, service, noteId } = context;
    const ticket = await this.hooks.cache.ticket(accountId);
    const cached = await this.hooks.cache.read(accountId, objectId);
    if (cached) return cached;
    if (!service || !noteId) throw new AttachmentReadError("signed-out");
    let blob: Blob;
    try {
      blob = await readAttachment(service, noteId, objectId, signal);
    } catch (error) {
      if (
        current() &&
        error instanceof AttachmentReadError &&
        error.kind === "unavailable"
      )
        this.unreadable(objectId);
      throw error;
    }
    if (ticket && current() && !this.gone(objectId))
      void this.hooks.cache.store(accountId, objectId, blob, ticket);
    return blob;
  }

  private async load(objectId: string) {
    const record = this.records.get(objectId);
    if (!record || !this.alive) return;
    this.invalidate(record);
    const attempt = record.attempt;
    const abort = new AbortController();
    record.abort = abort;
    const context = this.context();
    if (!context) return this.set(objectId, "offline");
    if (this.gone(objectId)) return this.set(objectId, "unavailable");
    const holds = this.fence(context);
    const current = () =>
      holds() &&
      this.records.get(objectId) === record &&
      record.attempt === attempt;
    this.set(objectId, "loading");
    try {
      const blob = await this.fetchBytes(
        objectId,
        context,
        abort.signal,
        current,
      );
      if (!current()) return;
      // Checked again now the bytes are here: the server may have taken the
      // object from the note meanwhile.
      if (this.gone(objectId)) return this.set(objectId, "unavailable");
      record.blob = blob;
      this.set(objectId, "shown");
    } catch (error) {
      if (!current()) return;
      const kind = error instanceof AttachmentReadError ? error.kind : "failed";
      // `unavailable` was recorded by `fetchBytes`.
      if (kind === "signed-out") this.set(objectId, "offline");
      else if (kind === "failed") this.set(objectId, "failed");
    } finally {
      if (record.abort === abort) record.abort = null;
    }
  }

  private closeImage() {
    if (!this.lightbox) return;
    this.lightbox = null;
    this.hooks.closeImage();
  }

  private set(objectId: string, status: ObjectStatus) {
    const record = this.records.get(objectId);
    if (!record) return;
    if (status !== "shown") record.blob = null;
    if (status === "unavailable" && this.lightbox?.objectId === objectId)
      this.closeImage();
    if (record.status === status && status !== "shown") return;
    record.status = status;
    for (const listener of record.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// Uploads.

type TaskState = "waiting" | "preparing" | "sending" | "finishing" | "failed";

interface UploadTask {
  id: string;
  seq: number;
  file: File;
  accountId: string;
  state: TaskState;
  progress: number | null;
  message: string;
  retryable: boolean;
  /** Stable for one logical upload, so a retry never makes a second object. */
  requestId: string;
  sha256: string | null;
  objectId: string | null;
  grant: UploadGrant | null;
  /** The service the upload's objects came from: they are released there. */
  service: AttachmentService | null;
  /** Whether `files.cancelUpload` was already asked for this object. */
  released: boolean;
  cancelled: boolean;
  /** In the note: its object is never released. */
  landed: boolean;
  abort: AbortController | null;
  dom: HTMLElement;
}

const requestId = () => "upload-" + crypto.randomUUID();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `promise`, or a retryable failure once `ms` pass; `promise` runs on. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new UploadError(
            "The server did not answer. Check the connection and retry.",
            true,
          ),
        ),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A file's name as sent: what the system gave it, or a plain default. */
function uploadName(file: File) {
  return (
    file.name.trim() || (file.type.startsWith("image/") ? "image" : "file")
  );
}

/** One editor's uploads, from choosing a file to its node in the note. */
export class UploadController {
  private readonly tasks = new Map<string, UploadTask>();
  private seq = 0;
  private running = 0;

  constructor(private readonly runtime: AttachmentRuntime) {}

  /** Begin uploading `files` to land at `pos`, in order. */
  start(view: EditorView, files: File[], pos: number) {
    const context = this.runtime.context();
    if (!context) return;
    const tasks = files.map((file) => {
      const task: UploadTask = {
        id: crypto.randomUUID(),
        seq: ++this.seq,
        file,
        accountId: context.accountId,
        state: "waiting",
        progress: null,
        message: "",
        retryable: false,
        requestId: requestId(),
        sha256: null,
        objectId: null,
        grant: null,
        service: null,
        released: false,
        cancelled: false,
        landed: false,
        abort: null,
        dom: document.createElement("div"),
      };
      this.build(task);
      this.tasks.set(task.id, task);
      return task;
    });
    view.dispatch(
      addUploads(
        view.state,
        tasks.map((task) => ({ id: task.id, pos, seq: task.seq })),
      ),
    );
    this.pump();
  }

  widget(id: string): HTMLElement | null {
    return this.tasks.get(id)?.dom ?? null;
  }

  /** The uploads not yet in the note (for tests). */
  pending(): { id: string; name: string; state: TaskState }[] {
    return [...this.tasks.values()].map((task) => ({
      id: task.id,
      name: uploadName(task.file),
      state: task.state,
    }));
  }

  /** Stop an upload and drop its mark: Cancel, or Remove after a failure. */
  cancel(id: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.cancelled = true;
    task.abort?.abort();
    this.tasks.delete(id);
    this.release(task);
    const view = this.runtime.view;
    if (view) view.dispatch(removeUpload(view.state, id));
  }

  retry(id: string) {
    const task = this.tasks.get(id);
    if (!task || task.state !== "failed") return;
    this.show(task, "waiting");
    this.pump();
  }

  /** The note closed: every unfinished upload is cancelled. */
  destroy() {
    for (const task of this.tasks.values()) {
      task.cancelled = true;
      task.abort?.abort();
      this.release(task);
    }
    this.tasks.clear();
  }

  private pump() {
    for (const task of this.tasks.values()) {
      if (this.running >= PARALLEL_UPLOADS) return;
      if (task.state !== "waiting") continue;
      this.running++;
      void this.run(task).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(task: UploadTask) {
    try {
      const grant = await this.send(task);
      if (task.cancelled) return;
      this.insert(task, grant);
    } catch (error) {
      if (
        task.cancelled ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        return;
      const failure = uploadRefusal(error);
      if (failure.restart) {
        // The object is gone or its ticket expired: start a new upload.
        task.requestId = requestId();
        task.objectId = null;
        task.grant = null;
        task.released = false;
      }
      this.fail(task, failure.message, failure.retryable);
    } finally {
      task.abort = null;
      // Cancelled while asking the server: release what it made.
      if (task.cancelled) this.release(task);
    }
  }

  /** The note's server ID, waiting briefly for a new note to be created. */
  private async noteId(task: UploadTask): Promise<string> {
    const deadline = Date.now() + NOTE_WAIT_MS;
    for (;;) {
      const noteId = this.runtime.context()?.noteId;
      if (noteId) return noteId;
      if (task.cancelled) throw new DOMException("Cancelled", "AbortError");
      if (Date.now() > deadline)
        throw new UploadError(
          "This note isn't on the server yet. Retry in a moment.",
          true,
        );
      await sleep(250);
    }
  }

  private service(task: UploadTask) {
    const context = this.runtime.context();
    const service = context?.service;
    if (
      !context ||
      !service ||
      context.accountId !== task.accountId ||
      !service.connected()
    )
      throw new UploadError(
        "Not connected. Retry when the connection is back.",
        true,
      );
    return service;
  }

  private async send(task: UploadTask): Promise<UploadGrant> {
    const { file } = task;
    if (file.size === 0) throw new UploadError("This file is empty.", false);
    if (file.size > MAX_FILE_BYTES)
      throw new UploadError("Files can be at most 25 MB.", false);
    this.show(task, "preparing");
    this.service(task);
    // Taken now: the bytes are kept only if the account's cache was not
    // cleared while the upload ran.
    const ticket = await this.runtime.hooks.cache.ticket(task.accountId);
    task.sha256 ??= await sha256Hex(file);
    const noteId = await this.noteId(task);
    if (task.cancelled) throw new DOMException("Cancelled", "AbortError");
    const ask = () => {
      const service = this.service(task);
      const request = task.requestId;
      task.service = service;
      const admission = service.createUpload({
        noteId,
        name: uploadName(file),
        mimeType: file.type,
        size: file.size,
        sha256: task.sha256!,
        requestId: request,
      });
      // The admission stays this upload's however late it answers
      // (review round 1, F7).
      void admission.then(
        (grant) => this.admitted(task, service, request, grant),
        () => undefined,
      );
      return within(admission, service.admissionWaitMs ?? ADMISSION_WAIT_MS);
    };
    let grant = await ask();
    task.objectId = grant.objectId;
    if (grant.state === "failed") {
      // An earlier attempt expired or was cancelled: a new request.
      task.requestId = requestId();
      grant = await ask();
      task.objectId = grant.objectId;
    }
    if (task.cancelled) throw new DOMException("Cancelled", "AbortError");
    if (grant.state === "failed")
      throw new UploadError("The upload could not start. Retry.", true, true);
    task.grant = grant;
    if (grant.state === "pending") {
      if (!grant.ticket)
        throw new UploadError("The upload could not start. Retry.", true, true);
      this.show(task, "sending", 0);
      task.abort = new AbortController();
      await putAttachment(grant.objectId, grant.ticket, file, {
        signal: task.abort.signal,
        progress: (fraction) => {
          if (!task.cancelled) this.show(task, "sending", fraction);
        },
      });
    }
    this.show(task, "finishing");
    // The bytes are here already: keep them so the picture shows at once.
    if (ticket)
      void this.runtime.hooks.cache.store(
        task.accountId,
        grant.objectId,
        file.slice(0, file.size, displayType(grant.mimeType)),
        ticket,
      );
    return grant;
  }

  /** The object is ready: put its node where the mark is now. */
  private insert(task: UploadTask, grant: UploadGrant) {
    const view = this.runtime.view;
    if (!view) {
      task.cancelled = true;
      this.release(task);
      return;
    }
    if (!fileWritesEnabled())
      return this.fail(
        task,
        "Files were turned off on the server. Retry once they are back on.",
        true,
      );
    if (!view.editable)
      return this.fail(task, "This note can't be edited right now.", true);
    const ids = attachmentIds(view.state.doc);
    if (!ids.includes(grant.objectId) && ids.length >= MAX_NOTE_ATTACHMENTS)
      return this.fail(
        task,
        `A note can hold at most ${MAX_NOTE_ATTACHMENTS} attachments.`,
        false,
      );
    const tr = insertUpload(
      view.state,
      task.id,
      uploadedNode(grant, task.file.size),
    );
    this.tasks.delete(task.id);
    if (!tr) {
      task.cancelled = true;
      this.release(task);
      return;
    }
    task.landed = true;
    view.dispatch(tr);
  }

  /**
   * An admission answered. One that answers after its upload was removed,
   * closed or started again is released, through the service that made it;
   * one that answers after the upload stopped waiting gives Remove its
   * object to release.
   */
  private admitted(
    task: UploadTask,
    service: AttachmentService,
    request: string,
    grant: UploadGrant,
  ) {
    if (grant.state === "failed" || task.landed) return;
    const current = task.requestId === request;
    if (current && !task.cancelled && this.tasks.has(task.id)) {
      task.objectId ??= grant.objectId;
      task.service ??= service;
      return;
    }
    if (current) {
      if (task.released && task.objectId === grant.objectId) return;
      task.objectId = grant.objectId;
      task.released = true;
    }
    void service.cancelUpload(grant.objectId).catch(() => undefined);
  }

  /** Ask the server to drop an object no note will use (best effort). */
  private release(task: UploadTask) {
    if (!task.objectId || task.released || task.landed || !task.service) return;
    task.released = true;
    void task.service.cancelUpload(task.objectId).catch(() => undefined);
  }

  private fail(task: UploadTask, message: string, retryable: boolean) {
    task.message = message;
    task.retryable = retryable;
    this.show(task, "failed");
  }

  private show(task: UploadTask, state: TaskState, progress?: number) {
    task.state = state;
    task.progress = progress ?? null;
    this.render(task);
  }

  private build(task: UploadTask) {
    const { dom } = task;
    const name = uploadName(task.file);
    dom.className = "upload-widget";
    dom.contentEditable = "false";
    dom.setAttribute("role", "group");
    dom.setAttribute("aria-label", "Upload of " + name);
    const row = document.createElement("div");
    row.className = "upload-row";
    const label = document.createElement("span");
    label.className = "upload-name";
    label.textContent = name;
    const detail = document.createElement("span");
    detail.className = "upload-detail";
    detail.setAttribute("role", "status");
    row.append(label, detail);
    const bar = document.createElement("progress");
    bar.className = "upload-progress";
    bar.max = 1;
    bar.setAttribute("aria-label", "Upload progress");
    const actions = document.createElement("div");
    actions.className = "upload-actions";
    for (const [action, text] of [
      ["cancel", "Cancel"],
      ["retry", "Retry"],
      ["remove", "Remove"],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = text;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        if (action === "retry") this.retry(task.id);
        else this.cancel(task.id);
      });
      actions.append(button);
    }
    dom.append(row, bar, actions);
    this.render(task);
  }

  private render(task: UploadTask) {
    const { dom } = task;
    dom.dataset.state = task.state;
    const detail = dom.querySelector<HTMLElement>(".upload-detail")!;
    const bar = dom.querySelector<HTMLProgressElement>(".upload-progress")!;
    detail.textContent =
      task.state === "waiting"
        ? "Waiting…"
        : task.state === "preparing"
          ? "Preparing…"
          : task.state === "sending"
            ? `Uploading… ${Math.round((task.progress ?? 0) * 100)}%`
            : task.state === "finishing"
              ? "Finishing…"
              : task.message;
    bar.hidden = task.state === "failed";
    if (task.progress === null) bar.removeAttribute("value");
    else bar.value = task.progress;
    for (const button of dom.querySelectorAll<HTMLButtonElement>("button")) {
      const action = button.dataset.action;
      button.hidden =
        task.state === "failed"
          ? action === "cancel" || (action === "retry" && !task.retryable)
          : action !== "cancel";
    }
  }
}
