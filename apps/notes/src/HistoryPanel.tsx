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
import { Icon } from "./Icons";
import { timeRange } from "./dates";
import type { LiveController } from "./live";
import { changed, diffText, type TextDiff } from "./text-diff";
import {
  canRestore,
  kindLabels,
  pageChain,
  pageKey,
  previousRevision,
  versionKey,
  type RestoreHold,
  type RestoreOutcome,
  type RestoreRequest,
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

const holdNotices: Record<
  Exclude<NonNullable<RestoreHold>, "pending">,
  string
> = {
  unsaved: "Waiting for your changes in this window to save…",
  offline: "Not connected. Restore when the connection is back.",
};

/**
 * How long a restore in flight keeps History open. After this the person may
 * close it; the note stays read-only in this window until the restore settles.
 */
export const RESTORE_PATIENCE_MS = 20_000;

interface RestoreCallbacks {
  /**
   * Records and sends a restore (App's `RestoreKeeper`); resolves with its
   * outcome. The note stays read-only until the outcome is known.
   */
  onRestore: (
    request: RestoreRequest,
    version: Version,
  ) => Promise<RestoreOutcome>;
  /** Sends an unresolved restore of this note again to learn its outcome. */
  onCheck: () => void;
}

type Current = { doc: string; revision: number } | null | undefined;

export default function HistoryPanel({
  live,
  noteId,
  title,
  restoreHold,
  connected,
  restoring,
  onClose,
  onRestore,
  onCheck,
}: {
  live: LiveController;
  noteId: string;
  title: string;
  /** Why this window may not restore now (see `restoreHold`), or null. */
  restoreHold: RestoreHold;
  connected: boolean;
  /** When this window sent the restore of this note it is waiting on. */
  restoring: number | null;
  onClose: () => void;
} & RestoreCallbacks) {
  return (
    <ConvexProvider client={live.client}>
      <History
        noteId={noteId as Id<"notes">}
        title={title}
        hold={restoreHold}
        connected={connected}
        restoring={restoring}
        onClose={onClose}
        onRestore={onRestore}
        onCheck={onCheck}
      />
    </ConvexProvider>
  );
}

function History({
  noteId,
  title,
  hold,
  connected,
  restoring,
  onClose,
  onRestore,
  onCheck,
}: {
  noteId: Id<"notes">;
  title: string;
  hold: RestoreHold;
  connected: boolean;
  restoring: number | null;
  onClose: () => void;
} & RestoreCallbacks) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  // While a restore is in flight, History stays open (so nothing behind it
  // can be typed into) until the answer, or for RESTORE_PATIENCE_MS.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (restoring === null) return;
    const wait = restoring + RESTORE_PATIENCE_MS - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), wait);
    return () => clearTimeout(timer);
  }, [restoring]);
  const pinned =
    restoring !== null && Date.now() - restoring < RESTORE_PATIENCE_MS;
  const pinnedNow = useRef(pinned);
  pinnedNow.current = pinned;
  const close = () => {
    if (!pinned) onClose();
  };
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
        close();
      }}
      // The browser may close the dialog itself (a second Escape without a
      // click in between cannot be cancelled): reopen it while a restore
      // holds it, and otherwise let App know it closed.
      onClose={() => {
        if (pinnedNow.current) ref.current?.showModal();
        else onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header className="history-header">
        <div>
          <h2>History</h2>
          <p className="history-note-title">{title}</p>
        </div>
        <button
          type="button"
          className="link-button"
          disabled={pinned}
          onClick={close}
        >
          Done
        </button>
      </header>
      {restoring !== null && !pinned && (
        <p role="status" className="history-stalled">
          Still restoring. You can close History; the restore may still apply,
          and this note stays read-only in this window until it is confirmed.
        </p>
      )}
      {restoring === null && hold === "pending" && (
        <div role="status" className="history-stalled">
          <p>
            A restore of this note from this browser is not confirmed yet. The
            note stays read-only until it is.
          </p>
          <button
            type="button"
            className="link-button"
            disabled={!connected}
            onClick={onCheck}
          >
            Check again
          </button>
        </div>
      )}
      <div className="history-body">
        <section className="history-versions" aria-label="Versions">
          <VersionList
            noteId={noteId}
            selected={selected}
            currentRevision={current?.revision}
            // The version being restored stays chosen until the answer.
            locked={restoring !== null}
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
              restoring={restoring !== null}
              onBack={() => setSelected(null)}
              onRestore={onRestore}
              onCheck={onCheck}
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
  locked,
  onSelect,
}: {
  noteId: Id<"notes">;
  selected: Version | null;
  currentRevision: number | undefined;
  locked: boolean;
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
            disabled={locked}
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
  restoring,
  onBack,
  onRestore,
  onCheck,
}: {
  noteId: Id<"notes">;
  version: Version;
  current: Current;
  hold: RestoreHold;
  restoring: boolean;
  onBack: () => void;
} & RestoreCallbacks) {
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
      <button
        type="button"
        className="history-back"
        disabled={restoring}
        onClick={onBack}
      >
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
        busy={restoring}
        onRestore={onRestore}
        onCheck={onCheck}
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
  version,
  current,
  hold,
  busy,
  onRestore,
}: {
  noteId: Id<"notes">;
  version: Version;
  current: Current;
  hold: RestoreHold;
  /** A restore of this note is in flight from this window. */
  busy: boolean;
} & RestoreCallbacks) {
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The latest hold and state, for the check just before sending.
  const holdNow = useRef(hold);
  holdNow.current = hold;
  const busyNow = useRef(busy);
  busyNow.current = busy;

  async function run() {
    // The panel is modal, so no typing starts here while it is open; still,
    // check again at the last moment.
    if (!current || holdNow.current || busyNow.current) return;
    busyNow.current = true;
    setNotice(null);
    // The revision the person is replacing; if someone edits first, the
    // server refuses rather than discarding their edit unseen. App records
    // the request before sending it and keeps the note read-only until the
    // outcome is known, even if History closes or the page reloads.
    const outcome = await onRestore(
      {
        revision: version.revision,
        expectedRevision: current.revision,
        requestId: crypto.randomUUID(),
      },
      version,
    );
    if (outcome.kind === "conflict") {
      setConfirming(false);
      setNotice(
        "The note changed before the restore reached it, so nothing was restored. History now shows the latest changes; restore again if you still want this version.",
      );
    } else if (outcome.kind === "unanswered") {
      setConfirming(false);
      setNotice(
        "The restore did not reach the server, so it is not confirmed yet. The note stays read-only here until it is.",
      );
    } else if (outcome.kind === "refused") setNotice(outcome.message);
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
      {hold && hold !== "pending" && (
        <p role="status" className="history-legend">
          {holdNotices[hold]}
        </p>
      )}
      {confirming ? (
        <div className="history-confirm">
          <p>
            Replace the note’s text with this version? Everyone with the note
            open sees the change. Typing not yet saved in other windows or on
            other devices is lost. The text it replaces stays in History.
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
