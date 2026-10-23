import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ConvexProvider,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react";
import { api } from "@palladian/notes-backend/api";
import type { Id } from "@palladian/notes-backend/dataModel";
import { parseStoredDoc } from "@palladian/notes-core/document";
import { plainText } from "@palladian/notes-core/projection";
import { notesSchema } from "@palladian/notes-core/schema";
import { DOMSerializer, type Node as ProseMirrorNode } from "prosemirror-model";
import type { CopyState } from "./copy-keys";
import { Icon } from "./Icons";
import { fileWritesEnabled } from "./file-capability";
import { timeRange } from "./dates";
import type { LiveController } from "./live";
import { transportError } from "./live";
import { changed, diffText, type TextDiff } from "./text-diff";
import {
  copyNeedsFiles,
  COPY_NEEDS_FILES_MESSAGE,
  isFilesOffRefusal,
  kindLabels,
  pageChain,
  pageKey,
  previousRevision,
  versionKey,
  type Version,
  type VersionPageResult,
} from "./versions";
import "./history.css";

/**
 * A note's server history (plan 08, A4; the UI after Deltos's HistoryPanel):
 * the versions, newest first, then one version read-only, compared with the
 * one before it or with the note now, and restored as a new note. Restoring
 * never touches the note itself (see the design change after review round 5
 * in docs/reviews/notes-history-implementation.md). Editors only (D13): the
 * server refuses everyone else.
 */

const PAGE = 30;

type Compare = "version" | "previous" | "current";
const compareLabels: Record<Compare, string> = {
  version: "Version",
  previous: "vs Previous",
  current: "vs Current",
};

/**
 * Creates a new note from a version's stored document (App does this, with
 * one creation key per version until answered: History review round 6).
 */
type RestoreAsNew = (doc: string, revision: number) => Promise<void>;
/** Whether a copy of a version is on its way, or sent without an answer. */
type CopyStateOf = (revision: number) => CopyState;

type Current = { doc: string; revision: number } | null | undefined;

export default function HistoryPanel({
  live,
  noteId,
  title,
  connected,
  copyState,
  onClose,
  onRestoreAsNew,
}: {
  live: LiveController;
  noteId: string;
  title: string;
  /** Signed in and connected now: creating a note needs the server. */
  connected: boolean;
  copyState: CopyStateOf;
  onClose: () => void;
  onRestoreAsNew: RestoreAsNew;
}) {
  return (
    <ConvexProvider client={live.client}>
      <History
        noteId={noteId as Id<"notes">}
        title={title}
        connected={connected}
        copyState={copyState}
        onClose={onClose}
        onRestoreAsNew={onRestoreAsNew}
      />
    </ConvexProvider>
  );
}

function History({
  noteId,
  title,
  connected,
  copyState,
  onClose,
  onRestoreAsNew,
}: {
  noteId: Id<"notes">;
  title: string;
  connected: boolean;
  copyState: CopyStateOf;
  onClose: () => void;
  onRestoreAsNew: RestoreAsNew;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  // The note now: what "vs Current" compares with.
  const current = useQuery(api.notes.content, { noteId });
  const [selected, setSelected] = useState<Version | null>(null);
  return (
    <dialog
      ref={ref}
      className={selected ? "history-panel has-selection" : "history-panel"}
      aria-label={`History of ${title}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      // The browser may close the dialog itself (a second Escape without a
      // click in between cannot be cancelled): let App know it closed.
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header className="history-header">
        <div>
          <h2>History</h2>
          <p className="history-note-title">{title}</p>
        </div>
        <button type="button" className="link-button" onClick={onClose}>
          Done
        </button>
      </header>
      <div className="history-body">
        <section className="history-versions" aria-label="Versions">
          <VersionList
            noteId={noteId}
            selected={selected}
            currentRevision={current?.revision}
            onSelect={setSelected}
          />
        </section>
        <section className="history-view" aria-label="Selected version">
          {selected ? (
            <VersionView
              key={versionKey(selected) + ":" + selected.revision}
              noteId={noteId}
              version={selected}
              current={current}
              connected={connected}
              copy={copyState(selected.revision)}
              onBack={() => setSelected(null)}
              onRestoreAsNew={onRestoreAsNew}
            />
          ) : (
            <p className="history-empty">
              Choose a version to read it, compare it, or restore it as a new
              note.
            </p>
          )}
        </section>
      </div>
    </dialog>
  );
}

/**
 * The versions, page by page. Each page is asked for from where the page
 * above it ends now (`pageChain`); a page still loading for its current
 * cursor shows as loading rather than as an older result, which could skip
 * versions that new ones pushed down from the page above.
 */
function VersionList({
  noteId,
  selected,
  currentRevision,
  onSelect,
}: {
  noteId: Id<"notes">;
  selected: Version | null;
  currentRevision: number | undefined;
  onSelect: (version: Version) => void;
}) {
  const [pages, setPages] = useState(1);
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const cursorKeys = cursors.map(pageKey).join();
  const request = useMemo(
    (): RequestForQueries =>
      Object.fromEntries(
        cursors.map((before) => [
          pageKey(before),
          {
            query: api.history.list,
            args: {
              noteId,
              limit: PAGE,
              ...(before === undefined ? {} : { before }),
            },
          },
        ]),
      ),
    [noteId, cursorKeys],
  );
  const loaded = useQueries(request);
  const results: Record<string, VersionPageResult | undefined> = {};
  for (const [key, result] of Object.entries(loaded)) {
    // As useQuery would: a refused or failed page reaches PanelBoundary.
    if (result instanceof Error) throw result;
    results[key] = result;
  }
  const chain = pageChain(pages, results);
  const wanted = chain.cursors.map(pageKey).join();
  useEffect(() => {
    if (wanted !== cursorKeys) setCursors(chain.cursors);
  }, [wanted]);
  const selectedKey = selected ? versionKey(selected) : null;
  return (
    <ol className="history-list">
      {chain.versions.map((version) => (
        <li key={versionKey(version)}>
          <button
            type="button"
            className="history-row"
            aria-pressed={selectedKey === versionKey(version)}
            onClick={() => onSelect(version)}
          >
            <span className="history-row-who">
              <strong>{version.actorName}</strong>
              {version.actorKind === "agent" && (
                <span className="history-badge">Agent</span>
              )}
              {version.revision === currentRevision && (
                <span className="history-badge current">Current</span>
              )}
            </span>
            <span className="history-row-what">{kindLabels[version.kind]}</span>
            <time
              dateTime={new Date(version.startedAt).toISOString()}
              title={new Date(version.startedAt).toLocaleString()}
            >
              {timeRange(version.startedAt, version.endedAt)}
            </time>
          </button>
        </li>
      ))}
      {chain.end === "loading" && <li className="history-loading">Loading…</li>}
      {chain.end === "done" && !chain.versions.length && (
        <li className="history-empty">No versions yet.</li>
      )}
      {chain.end === "more" && (
        <li>
          <button
            type="button"
            className="history-older"
            onClick={() => setPages((count) => count + 1)}
          >
            Show older versions
          </button>
        </li>
      )}
    </ol>
  );
}

function VersionView({
  noteId,
  version,
  current,
  connected,
  copy,
  onBack,
  onRestoreAsNew,
}: {
  noteId: Id<"notes">;
  version: Version;
  current: Current;
  connected: boolean;
  copy: CopyState;
  onBack: () => void;
  onRestoreAsNew: RestoreAsNew;
}) {
  const [compare, setCompare] = useState<Compare>("version");
  const shown = useQuery(api.history.read, {
    noteId,
    revision: version.revision,
  });
  const previousAt = previousRevision(version);
  const previous = useQuery(
    api.history.read,
    compare === "previous" && previousAt !== null
      ? { noteId, revision: previousAt }
      : "skip",
  );
  const shownDoc = useMemo(
    () => (shown ? parseStoredDoc(shown.doc) : null),
    [shown?.doc],
  );
  const shownText = useMemo(
    () => (shownDoc ? plainText(shownDoc) : null),
    [shownDoc],
  );
  const previousText = useMemo(
    () => (previous ? plainText(parseStoredDoc(previous.doc)) : null),
    [previous?.doc],
  );
  // Read the note now only while comparing with it; it changes as people type.
  const currentDoc = compare === "current" ? current?.doc : undefined;
  const currentText = useMemo(
    () =>
      currentDoc === undefined ? null : plainText(parseStoredDoc(currentDoc)),
    [currentDoc],
  );
  const diff = useMemo((): TextDiff | null => {
    if (shownText === null) return null;
    if (compare === "previous") {
      if (previousAt === null) return diffText("", shownText);
      return previousText === null ? null : diffText(previousText, shownText);
    }
    if (compare === "current")
      return currentText === null ? null : diffText(shownText, currentText);
    return null;
  }, [compare, previousAt, shownText, previousText, currentText]);
  // While files are off, a copy may keep only the file content the note has
  // now; say so before sending rather than after the server refuses.
  const filesOn = fileWritesEnabled();
  const needsFiles = useMemo(
    () =>
      !!shownDoc &&
      copyNeedsFiles(
        shownDoc,
        current ? parseStoredDoc(current.doc) : null,
        filesOn,
      ),
    [shownDoc, current?.doc, filesOn],
  );

  return (
    <>
      <button type="button" className="history-back" onClick={onBack}>
        <Icon name="back" size={15} />
        Versions
      </button>
      <p className="history-meta">
        <strong>{version.actorName}</strong>
        {version.actorKind === "agent" && (
          <span className="history-badge">Agent</span>
        )}
        <span>
          {kindLabels[version.kind]} ·{" "}
          {timeRange(version.startedAt, version.endedAt)}
        </span>
      </p>
      <div className="history-compare" role="group" aria-label="Show">
        {(Object.keys(compareLabels) as Compare[]).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={compare === id}
            onClick={() => setCompare(id)}
          >
            {compareLabels[id]}
          </button>
        ))}
      </div>
      {compare !== "version" && (
        <p className="history-legend">
          {compare === "previous" && previousAt === null
            ? "The first version, compared with an empty note."
            : compare === "previous"
              ? "Highlighted text was added in this version; struck-through text was removed."
              : current === null
                ? "The note is not available to compare with."
                : "Highlighted text was added since this version; struck-through text has been removed since."}
          {diff?.detail === "line" &&
            " This note is long, so it is compared line by line."}
          {diff?.detail === "block" &&
            " These versions differ too much to compare in detail; the changed part is shown removed, then added."}
        </p>
      )}
      <div className="history-content">
        {shown === undefined || shownDoc === null ? (
          <p className="history-loading">Loading…</p>
        ) : compare === "version" ? (
          <RenderedDoc doc={shownDoc} />
        ) : diff ? (
          <>
            {!changed(diff) && (
              <p className="history-legend">No differences.</p>
            )}
            <DiffView diff={diff} />
          </>
        ) : current === null && compare === "current" ? null : (
          <p className="history-loading">Loading…</p>
        )}
      </div>
      <NewNoteControls
        doc={shown?.doc ?? null}
        connected={connected}
        needsFiles={needsFiles}
        copy={copy}
        onRestoreAsNew={(doc) => onRestoreAsNew(doc, version.revision)}
      />
    </>
  );
}

/** The version as the note showed it, rendered with the editor's own schema. */
function RenderedDoc({ doc }: { doc: ProseMirrorNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const fragment = DOMSerializer.fromSchema(notesSchema).serializeFragment(
      doc.content,
    );
    // Links in a past version open beside the app, never in its place.
    for (const link of fragment.querySelectorAll("a[href]")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
    host.replaceChildren(fragment);
  }, [doc]);
  return (
    <div
      ref={ref}
      className="history-doc"
      role="document"
      aria-label="Version text"
    />
  );
}

function DiffView({ diff }: { diff: TextDiff }) {
  return (
    <div className="history-diff" role="document" aria-label="Changes">
      {diff.parts.map((part, index) =>
        part.op === "insert" ? (
          <ins key={index}>{part.text}</ins>
        ) : part.op === "delete" ? (
          <del key={index}>{part.text}</del>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </div>
  );
}

/**
 * "Restore as a new note": confirm, then App creates the note (and closes
 * History, offering Open). Nothing changes in the note whose history this is.
 */
function NewNoteControls({
  doc,
  connected,
  needsFiles,
  copy,
  onRestoreAsNew,
}: {
  /** The version's stored document, once read. */
  doc: string | null;
  connected: boolean;
  /** The version has file content the server cannot copy yet. */
  needsFiles: boolean;
  /** A copy of this version on its way, or sent without an answer. */
  copy: CopyState;
  onRestoreAsNew: (doc: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(copy === "sending");
  const [sending, setBusy] = useState(false);
  // Also while a copy sent before History was closed is on its way.
  const busy = sending || copy === "sending";
  const [notice, setNotice] = useState<string | null>(null);
  async function run() {
    if (!doc || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      // On success App closes History; otherwise the panel stays usable.
      await onRestoreAsNew(doc);
    } catch (failure) {
      const error = transportError(failure);
      setNotice(
        isFilesOffRefusal(error) ? COPY_NEEDS_FILES_MESSAGE : error.message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <footer className="history-actions">
      {notice && (
        <p role="alert" className="error">
          {notice}
        </p>
      )}
      {!connected && (
        <p role="status" className="history-legend">
          Not connected. Restore when the connection is back.
        </p>
      )}
      {needsFiles && (
        <p role="status" className="history-legend">
          {COPY_NEEDS_FILES_MESSAGE}
        </p>
      )}
      {copy === "unconfirmed" && !busy && (
        <p role="status" className="history-legend">
          The last restore of this version was not confirmed. Restoring it again
          finishes that one, without making a second note.
        </p>
      )}
      {confirming ? (
        <div className="history-confirm">
          <p>
            Create a new note with this version’s text? This note stays as it
            is.
          </p>
          <div className="button-row">
            <button
              type="button"
              disabled={busy || !connected || !doc || needsFiles}
              onClick={() => void run()}
            >
              {busy ? "Creating…" : "Create note"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="history-restore"
          disabled={!connected || !doc || needsFiles}
          onClick={() => {
            setNotice(null);
            setConfirming(true);
          }}
        >
          Restore as a new note…
        </button>
      )}
    </footer>
  );
}
