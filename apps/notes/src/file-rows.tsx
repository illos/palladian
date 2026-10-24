import { useEffect, useRef, useState } from "react";
import { attachmentCache } from "./attachment-cache";
import type { NotesStore, NoteSummary } from "./cache";
import { fileNoteOf, type FileNoteFile } from "./file-notes";
import { Icon } from "./Icons";

/**
 * File notes in the note list (plan 08 B4): a thumbnail or type icon and a
 * "PDF · 2.4 MB" label. Derived on this device from the note documents it
 * already caches (the live layer caches every note's text), so the server's
 * summaries are unchanged. Only the rows shown are read, after the list is
 * on screen; never attachment bytes.
 */

const NONE: ReadonlyMap<string, FileNoteFile> = new Map();
/**
 * A note's text can reach the device cache after its new summary (another
 * device's edit): a row edited this recently is read again whenever the
 * list renders, for this long after it first showed.
 */
const SETTLE_MS = 60_000;

/**
 * The file notes among `rows`, from their cached documents, while `enabled`
 * (files on). Each row is read when it first shows and after each edit, and
 * again while that edit is recent; one pass at a time, never all at once.
 */
export function useFileNotes(
  store: Pick<NotesStore, "read">,
  accountId: string | null,
  rows: readonly NoteSummary[],
  enabled: boolean,
): ReadonlyMap<string, FileNoteFile> {
  /** What each note's document was, by account, note, edit time and kind. */
  const known = useRef(
    new Map<string, { file: FileNoteFile | null; since: number }>(),
  );
  /** A read pass under way, and whether rows came due meanwhile. */
  const reading = useRef(false);
  const again = useRef(false);
  const [, setRead] = useState(0);
  const key = (row: NoteSummary) =>
    `${row.accountId}\n${row.id}\n${row.updatedAt}\n${row.kind}`;
  // After every render: the list renders when the device cache changes.
  useEffect(() => {
    if (!enabled || !accountId) return;
    // Each edit makes a new key; keep only the rows shown once it grows.
    if (known.current.size > 4 * rows.length + 500) {
      const keep = new Set(rows.map(key));
      for (const entry of known.current.keys())
        if (!keep.has(entry)) known.current.delete(entry);
    }
    const now = Date.now();
    // Not read yet, or edited in the last minute and first seen less than
    // a minute ago (its text may still be on its way).
    const due = rows.filter((row) => {
      if (row.accountId !== accountId) return false;
      const entry = known.current.get(key(row));
      return (
        !entry ||
        (now - entry.since < SETTLE_MS && now - row.updatedAt < SETTLE_MS)
      );
    });
    if (!due.length) return;
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    void (async () => {
      let changed = false;
      for (const row of due) {
        const at = key(row);
        const body = await store.read(accountId, row.id).catch(() => undefined);
        if (!body) continue;
        const file = fileNoteOf(body.document);
        const entry = known.current.get(at);
        known.current.set(at, { file, since: entry?.since ?? now });
        if (JSON.stringify(file) !== JSON.stringify(entry?.file ?? null))
          changed = true;
      }
      reading.current = false;
      // Rows that came due during the pass are read on the next render.
      if (changed || again.current) setRead((count) => count + 1);
      again.current = false;
    })();
  });
  if (!enabled || !accountId) return NONE;
  const files = new Map<string, FileNoteFile>();
  for (const row of rows) {
    const file =
      row.accountId === accountId ? known.current.get(key(row))?.file : null;
    if (file) files.set(row.id, file);
  }
  return files;
}

/**
 * A file note's leading picture in its row: the picture itself when this
 * page already holds its bytes (shown or uploaded here, in memory), else a
 * type icon. Nothing is read for it. A clear of the byte cache (sign-out,
 * another account, files off) takes the picture away at once.
 */
export function FileRowVisual({ file }: { file: FileNoteFile }) {
  const [shown, setShown] = useState<{ blob: Blob; url: string } | null>(null);
  const picture = useRef<HTMLImageElement>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // Looked up again whenever the list renders, so bytes this page reads
  // later (opening the note) show here too: a lookup in memory, never a read.
  useEffect(() => {
    const blob =
      file.kind === "image"
        ? attachmentCache.read(attachmentCache.current(), file.objectId)
        : null;
    if (blob === (shownRef.current?.blob ?? null)) return;
    setShown(blob ? { blob, url: URL.createObjectURL(blob) } : null);
  });
  // Each picture's address lasts as long as it shows.
  useEffect(() => {
    if (!shown) return;
    return () => URL.revokeObjectURL(shown.url);
  }, [shown]);
  // Any clear takes the picture off the page at once.
  useEffect(
    () =>
      attachmentCache.onClear(() => {
        picture.current?.removeAttribute("src");
        setShown(null);
      }),
    [],
  );
  const url = shown?.url ?? null;
  return (
    <span className="row-file-visual" aria-hidden="true">
      {url ? (
        <img ref={picture} src={url} alt="" />
      ) : (
        <Icon name={file.kind === "image" ? "image" : "file"} size={22} />
      )}
    </span>
  );
}
