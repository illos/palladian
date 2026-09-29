import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SessionController } from "./session";
import { type NoteBody, type NoteSummary, type NotesStore } from "./cache";
import { emptyDocument, validateCachedDocument } from "./document";
import { EditorSurface } from "./EditorSurface";
import "./styles.css";

interface OpenNote extends NoteBody {
  kind: "cached" | "draft";
  generation: number;
}
const statusLabels = {
  connecting: "Connecting — cached notes remain available",
  ready: "Session connected — local foundation",
  retrying: "Reconnecting — cached notes remain available",
  expired: "Sign in again to reconnect — cached notes remain available",
  revoked: "Device access revoked",
  "signed-out": "Signed out",
};
export function App({
  session,
  store,
}: {
  session: SessionController;
  store: NotesStore;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [open, setOpen] = useState<OpenNote | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState(
    "Local draft — not saved to server",
  );
  const openRequest = useRef(0);
  const listRequest = useRef(0);
  const writeRequest = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const accountId = snapshot.accountId;
  const permitted =
    accountId !== null &&
    snapshot.status !== "revoked" &&
    snapshot.status !== "signed-out";
  const currentOpen = permitted && open?.accountId === accountId ? open : null;
  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);
  useEffect(() => {
    let mounted = true;
    setRows([]);
    setOpen(null);
    setError(null);
    openRequest.current++;
    async function refresh() {
      const request = ++listRequest.current;
      if (!accountId || !permitted) return;
      try {
        const result = await store.list(accountId);
        if (
          mounted &&
          request === listRequest.current &&
          snapshotRef.current.accountId === accountId
        )
          setRows(result);
      } catch {
        if (mounted)
          setError(
            "Local notes could not be loaded. Your server notes have not been deleted.",
          );
      }
    }
    void refresh();
    const unsubscribe = store.subscribe((event) => {
      if (event.invalidated && event.accountId === accountId) {
        openRequest.current++;
        setRows([]);
        setOpen(null);
      }
      void refresh();
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [accountId, permitted, store]);
  async function selectNote(row: NoteSummary) {
    if (currentOpen?.id === row.id) return;
    const request = ++openRequest.current;
    const generation = snapshot.generation;
    try {
      const body = await store.read(row.accountId, row.id);
      if (
        request !== openRequest.current ||
        snapshotRef.current.accountId !== row.accountId ||
        snapshotRef.current.generation !== generation
      )
        return;
      if (!body) {
        setError("This note's text is not cached on this device yet.");
        return;
      }
      validateCachedDocument(body.document);
      setError(null);
      setOpen({ ...body, kind: row.kind, generation });
      setSaveState("Local draft — not saved to server");
    } catch {
      setError("This note could not be opened from local storage.");
    }
  }
  async function createDraft() {
    if (!accountId || !permitted) return;
    const draft: OpenNote = {
      accountId,
      id: crypto.randomUUID(),
      document: emptyDocument(),
      text: "",
      kind: "draft",
      generation: snapshot.generation,
    };
    openRequest.current++;
    setOpen(draft); // Typing can start before IDB or authentication completes.
    setSaveState("Saving draft on this device…");
    await persistDraft(draft, draft.document, "");
  }
  async function persistDraft(note: OpenNote, document: string, text: string) {
    const request = ++writeRequest.current;
    setSaveState("Saving draft on this device…");
    try {
      await store.writeDraft({
        accountId: note.accountId,
        id: note.id,
        document,
        text,
        updatedAt: Date.now(),
      });
      if (
        snapshotRef.current.accountId === note.accountId &&
        snapshotRef.current.status !== "revoked" &&
        snapshotRef.current.status !== "signed-out" &&
        request === writeRequest.current
      )
        setSaveState("Draft saved on this device — not saved to server");
    } catch {
      if (
        snapshotRef.current.accountId === note.accountId &&
        snapshotRef.current.status !== "revoked" &&
        snapshotRef.current.status !== "signed-out" &&
        request === writeRequest.current
      ) {
        setSaveState("Draft not saved — keep this window open");
        setError(
          "Local storage failed. Your latest typing is still visible, but may be lost if this window closes.",
        );
      }
    }
  }
  const visibleRows = permitted
    ? rows.filter(
        (row) =>
          row.accountId === accountId &&
          (row.title + " " + row.preview)
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
      )
    : [];
  return (
    <div className={currentOpen ? "notes-app has-note" : "notes-app"}>
      <aside className="library" aria-label="Notes library">
        <header className="library-header">
          <span className="wordmark">Palladian</span>
          <button
            onClick={() => {
              void createDraft();
            }}
            disabled={!permitted}
            aria-label="New note"
          >
            ＋
          </button>
        </header>
        <h1>All notes</h1>
        <label className="search">
          <span className="sr-only">Search cached titles and previews</span>
          <input
            type="search"
            placeholder="Search cached notes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="note-list" aria-label="Cached notes">
          {visibleRows.map((row) => (
            <button
              className={
                currentOpen?.id === row.id ? "note-row selected" : "note-row"
              }
              key={row.id}
              onClick={() => {
                void selectNote(row);
              }}
            >
              <strong>{row.title}</strong>
              <span>{row.preview || "Empty note"}</span>
              {row.kind === "draft" && <small>Local draft</small>}
            </button>
          ))}
          {!visibleRows.length && (
            <p className="empty-list">
              {permitted
                ? "No matching notes cached here yet."
                : "Connect an account to open its cached library."}
            </p>
          )}
        </div>
        <footer>
          <p role="status" data-testid="session-status">
            {statusLabels[snapshot.status]}
          </p>
          {snapshot.error && <p>{snapshot.error}</p>}
          <button onClick={() => session.retry()}>Retry connection</button>
          <button
            onClick={() => {
              void session
                .logout()
                .catch(() =>
                  setError(
                    "Sign out could not finish. Your notes remain protected from switching accounts.",
                  ),
                );
            }}
            disabled={!permitted}
          >
            Sign out
          </button>
        </footer>
      </aside>
      <main className="note-surface">
        <div className="foundation-banner">
          Local foundation • live editing and server saves are not connected
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {currentOpen ? (
          <>
            <div className="note-toolbar">
              <button
                className="back-button"
                onClick={() => {
                  openRequest.current++;
                  setOpen(null);
                }}
              >
                ‹ All notes
              </button>
              <span>
                {currentOpen.kind === "draft"
                  ? saveState
                  : "Cached copy — read only"}
              </span>
            </div>
            <EditorSurface
              key={currentOpen.id + ":" + currentOpen.generation}
              document={currentOpen.document}
              text={currentOpen.text}
              editable={currentOpen.kind === "draft"}
              onChange={(document, text) => {
                void persistDraft(currentOpen, document, text);
              }}
            />
          </>
        ) : (
          <div className="welcome">
            <p className="eyebrow">A quiet place to think</p>
            <h2>Your notes, ready when you are.</h2>
            <p>
              Open a cached note or start a draft. Connection checks happen in
              the background.
            </p>
            <button
              disabled={!permitted}
              onClick={() => {
                void createDraft();
              }}
            >
              New note
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
