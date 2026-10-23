import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ConvexProvider,
  useMutation,
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
import { Icon } from "./Icons";
import { timeRange } from "./dates";
import type { LiveController } from "./live";
import { transportError } from "./live";
import { changed, diffText, type TextDiff } from "./text-diff";
import {
  canRestore,
  kindLabels,
  pageChain,
  pageKey,
  previousRevision,
  RestoreRequests,
  versionKey,
  type RestoreHold,
  type Version,
  type VersionPageResult,
} from "./versions";
import "./history.css";

/**
 * A note's server history (plan 08, A4; the UI after Deltos's HistoryPanel):
 * the versions, newest first, then one version read-only, compared with the
 * one before it or with the note now, and restored. Restoring appends a
 * revision on the server; open editors, this device's included, receive it
 * through collaboration. Editors only (D13): the server refuses everyone else.
 */

const PAGE = 30;

type Compare = "version" | "previous" | "current";
const compareLabels: Record<Compare, string> = {
  version: "Version",
  previous: "vs Previous",
  current: "vs Current",
};

const holdNotices: Record<NonNullable<RestoreHold>, string> = {
  unsaved: "Waiting for your changes to save…",
  offline: "Not connected. Restore when the connection is back.",
};

type Current = { doc: string; revision: number } | null | undefined;

export default function HistoryPanel({
  live,
  noteId,
  title,
  restoreHold,
  onClose,
  onRestored,
}: {
  live: LiveController;
  noteId: string;
  title: string;
  /** Why this device may not restore now (see `restoreHold`), or null. */
  restoreHold: RestoreHold;
  onClose: () => void;
  onRestored: (version: Version) => void;
}) {
  return (
    <ConvexProvider client={live.client}>
      <History
        noteId={noteId as Id<"notes">}
        title={title}
        hold={restoreHold}
        onClose={onClose}
        onRestored={onRestored}
      />
    </ConvexProvider>
  );
}

function History({
  noteId,
  title,
  hold,
  onClose,
  onRestored,
}: {
  noteId: Id<"notes">;
  title: string;
  hold: RestoreHold;
  onClose: () => void;
  onRestored: (version: Version) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  // The note now: what "vs Current" compares with, and the revision a restore
  // expects to replace.
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
              hold={hold}
              onBack={() => setSelected(null)}
              onRestored={onRestored}
            />
          ) : (
            <p className="history-empty">
              Choose a version to read it, compare it or restore it.
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
  hold,
  onBack,
  onRestored,
}: {
  noteId: Id<"notes">;
  version: Version;
  current: Current;
  hold: RestoreHold;
  onBack: () => void;
  onRestored: (version: Version) => void;
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
      <RestoreControls
        noteId={noteId}
        version={version}
        current={current}
        hold={hold}
        onRestored={onRestored}
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

function RestoreControls({
  noteId,
  version,
  current,
  hold,
  onRestored,
}: {
  noteId: Id<"notes">;
  version: Version;
  current: Current;
  hold: RestoreHold;
  onRestored: (version: Version) => void;
}) {
  const restore = useMutation(api.history.restore);
  const [requests] = useState(
    () => new RestoreRequests(() => crypto.randomUUID()),
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The latest hold, for the check just before sending.
  const holdNow = useRef(hold);
  holdNow.current = hold;

  async function run() {
    // The panel is modal, so no typing starts here while it is open; still,
    // check again at the last moment.
    if (!current || holdNow.current) return;
    // The revision the person is replacing; if someone edits first, the
    // server refuses rather than discarding their edit unseen.
    const request = requests.next(version.revision, current.revision);
    setBusy(true);
    setNotice(null);
    try {
      await restore({ noteId, ...request });
      requests.settled(request);
      onRestored(version);
    } catch (failure) {
      const error = transportError(failure);
      // Unanswered: Restore again repeats this request exactly.
      if (error.code === "transient")
        return setNotice("The restore did not reach the server. Try again.");
      requests.settled(request);
      if (error.code === "conflict") {
        setConfirming(false);
        setNotice(
          "The note changed before the restore reached it, so nothing was restored. History now shows the latest changes; restore again if you still want this version.",
        );
      } else setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (!current) return null;
  if (!canRestore(version, current.revision))
    return (
      <footer className="history-actions">
        <p className="history-legend">This is the note as it is now.</p>
      </footer>
    );
  return (
    <footer className="history-actions">
      {notice && (
        <p role="alert" className="error">
          {notice}
        </p>
      )}
      {hold && (
        <p role="status" className="history-legend">
          {holdNotices[hold]}
        </p>
      )}
      {confirming ? (
        <div className="history-confirm">
          <p>
            Replace the note’s text with this version? Everyone with the note
            open sees the change. The text it replaces stays in History.
          </p>
          <div className="button-row">
            <button
              type="button"
              disabled={busy || !!hold}
              onClick={() => void run()}
            >
              {busy ? "Restoring…" : "Restore"}
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
          disabled={!!hold}
          onClick={() => {
            setNotice(null);
            setConfirming(true);
          }}
        >
          Restore this version…
        </button>
      )}
    </footer>
  );
}
