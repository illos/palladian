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
 * on screen, and each note once per edit; never attachment bytes.
 */

const NONE: ReadonlyMap<string, FileNoteFile> = new Map();

/**
 * The file notes among `rows`, from their cached documents, while `enabled`
 * (files on). A row whose text is not cached yet is read again when the
 * list next changes.
 */
export function useFileNotes(
  store: NotesStore,
  accountId: string | null,
  rows: readonly NoteSummary[],
  enabled: boolean,
): ReadonlyMap<string, FileNoteFile> {
  /** What each note's document was, by account, note, edit time and kind. */
  const known = useRef(new Map<string, FileNoteFile | null>());
  const [, setRead] = useState(0);
  const key = (row: NoteSummary) =>
    `${row.accountId}\n${row.id}\n${row.updatedAt}\n${row.kind}`;
  const shown = rows.map(key).join("\n");
  useEffect(() => {
    if (!enabled || !accountId) return;
    // Each edit makes a new key; keep only the rows shown once it grows.
    if (known.current.size > 4 * rows.length + 500) {
      const keep = new Set(rows.map(key));
      for (const entry of known.current.keys())
        if (!keep.has(entry)) known.current.delete(entry);
    }
    const missing = rows.filter(
      (row) => row.accountId === accountId && !known.current.has(key(row)),
    );
    if (!missing.length) return;
    let alive = true;
    void (async () => {
      let found = false;
      for (const row of missing) {
        const body = await store
          .read(accountId, row.id)
          .catch(() => undefined);
        if (!alive) return;
        if (!body) continue;
        known.current.set(key(row), fileNoteOf(body.document));
        found = true;
      }
      if (alive && found) setRead((count) => count + 1);
    })();
    return () => {
      alive = false;
    };
    // `shown` stands for `rows`, which is a new array on every render.
  }, [enabled, accountId, shown, store]);
  if (!enabled || !accountId) return NONE;
  const files = new Map<string, FileNoteFile>();
  for (const row of rows) {
    const file =
      row.accountId === accountId ? known.current.get(key(row)) : null;
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
  const [url, setUrl] = useState<string | null>(null);
  const picture = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (file.kind !== "image") return;
    const blob = attachmentCache.read(attachmentCache.current(), file.objectId);
    let made: string | null = blob ? URL.createObjectURL(blob) : null;
    setUrl(made);
    const drop = () => {
      if (made) URL.revokeObjectURL(made);
      made = null;
    };
    const stop = attachmentCache.onClear(() => {
      picture.current?.removeAttribute("src");
      drop();
      setUrl(null);
    });
    return () => {
      stop();
      drop();
    };
  }, [file.kind, file.objectId]);
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
