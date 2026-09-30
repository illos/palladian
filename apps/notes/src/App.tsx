import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SessionController } from "./session";
import { type NoteBody, type NoteSummary, type NotesStore } from "./cache";
import { emptyDocument, validateCachedDocument } from "./document";
import { EditorSurface } from "./EditorSurface";
import { Icon } from "./Icons";
import { Appearance } from "./Appearance";
import "./theme.css";
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
  const [view, setView] = useState<"notes" | "appearance">("notes");
  const navSheet = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [open, setOpen] = useState<OpenNote | null>(null);
  const [query, setQuery] = useState("");
  const [rowLimit, setRowLimit] = useState(60);
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
    setRowLimit(60);
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
    setView("notes");
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
    setView("notes");
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
  function navigate(next: "notes" | "appearance") {
    setView(next);
    navSheet.current?.close();
  }
  const navigation = <>
    <div className="wordmark">palladian</div>
    <p className="nav-label">Collections</p>
    <button className={view === "notes" ? "nav-item active" : "nav-item"} onClick={() => navigate("notes")}>
      <Icon name="notes" size={17}/><span>All Notes</span><small>{permitted ? rows.length : 0}</small>
    </button>
    <div className="nav-spacer"/>
    <div className="nav-footer"><button className={view === "appearance" ? "nav-item active" : "nav-item"} onClick={() => navigate("appearance")}>
      <Icon name="settings" size={17}/><span>Settings</span>
    </button></div>
  </>;
  return (
    <div className={["notes-app", currentOpen && "has-note", view === "appearance" && "settings-view"].filter(Boolean).join(" ")}>
      <aside className="navigation" aria-label="Navigation">{navigation}</aside>
      <aside className="library" aria-label="Notes library">
        <div className="library-notes" hidden={view !== "notes"}>
          <header className="library-header">
            <div><h1>All notes</h1><p className="note-count">{visibleRows.length} notes</p></div>
            <button onClick={() => { void createDraft(); }} disabled={!permitted} aria-label="New note"><Icon name="compose" size={21}/></button>
          </header>
          <label className="search">
            <Icon name="search" size={17}/><span className="sr-only">Search cached titles and previews</span>
            <input ref={search} type="search" placeholder="Search notes…" value={query} onChange={(event) => { setQuery(event.target.value); setRowLimit(60); }}/>
          </label>
          <div className="note-list" aria-label="Cached notes" onScroll={(event) => {
            const list = event.currentTarget;
            if (list.scrollHeight - list.scrollTop - list.clientHeight < 200) setRowLimit(limit => Math.min(visibleRows.length, limit + 60));
          }}>
            {visibleRows.slice(0, rowLimit).map(row => <button className={currentOpen?.id === row.id ? "note-row selected" : "note-row"} key={row.id} onClick={() => { void selectNote(row); }}>
              <strong>{row.title}</strong>
              <span className="row-detail"><time dateTime={new Date(row.updatedAt).toISOString()}>{smartDate(row.updatedAt)}</time><span className="row-preview">{row.preview || "Empty note"}</span></span>
              {row.kind === "draft" && <small>Local draft</small>}
            </button>)}
            {rowLimit < visibleRows.length && <button className="show-more" onClick={() => setRowLimit(limit => limit + 60)}>Show more notes</button>}
            {!visibleRows.length && <p className="empty-list">{permitted ? "No matching notes cached here yet." : "Connect an account to open its cached library."}</p>}
          </div>
          <footer className="connection-footer">
            <p role="status" data-testid="session-status">{statusLabels[snapshot.status]}</p>
            {snapshot.error && <p>{snapshot.error}</p>}
            <details><summary>Connection</summary><button onClick={() => session.retry()}>Retry connection</button><button onClick={() => { void session.logout().catch(() => setError("Sign out could not finish. Your notes remain protected from switching accounts.")); }} disabled={!permitted}>Sign out</button></details>
          </footer>
        </div>
        <div className="settings-rail" hidden={view !== "appearance"}>
          <button className="settings-back" onClick={() => navigate("notes")}><Icon name="back" size={15}/>Notes</button>
          <h1>Settings</h1>
          <button className="settings-tab active" aria-current="page"><Icon name="sun" size={20}/>Appearance</button>
        </div>
        <div className="mobile-home-bar" hidden={view !== "notes"}>
          <button className="sheet-handle" aria-label="Open navigation" onClick={() => navSheet.current?.showModal()}><span/></button>
          <div className="mobile-home-actions"><button aria-label="New note" onClick={() => { void createDraft(); }} disabled={!permitted}><Icon name="compose" size={22}/><span>New</span></button><button onClick={() => navSheet.current?.showModal()}><Icon name="menu" size={22}/><span>Menu</span></button><button onClick={() => search.current?.focus()}><Icon name="search" size={22}/><span>Search</span></button></div>
        </div>
      </aside>
      <main className="note-surface">
        {error && <p className="error" role="alert">{error}</p>}
        <section className="note-content-region" hidden={view !== "notes"}>
          {currentOpen ? <>
            <div className="note-toolbar">
              <button className="back-button" onClick={() => { openRequest.current++; setOpen(null); }}><Icon name="back" size={18}/>All notes</button>
              <span className="edited-date">Edited {smartDate(rows.find(row => row.id === currentOpen.id)?.updatedAt ?? Date.now())}</span>
              <span className="save-status">{currentOpen.kind === "draft" ? saveState : "Cached copy — read only"}</span>
            </div>
            <EditorSurface key={currentOpen.id + ":" + currentOpen.generation} document={currentOpen.document} text={currentOpen.text} editable={currentOpen.kind === "draft"} onChange={(document, text) => { void persistDraft(currentOpen, document, text); }}/>
          </> : <div className="welcome"><p>Select a note to start reading.</p><button disabled={!permitted} onClick={() => { void createDraft(); }}>New note</button></div>}
        </section>
        <section className="appearance-region" hidden={view !== "appearance"}>
          <header className="settings-pane-header"><button className="back-button" onClick={() => navigate("notes")}><Icon name="back" size={18}/>Notes</button><h2>Appearance</h2></header>
          <div className="settings-pane-body"><Appearance/></div>
        </section>
      </main>
      <dialog ref={navSheet} className="mobile-nav-sheet" aria-label="Navigation" onClick={event => { if (event.target === event.currentTarget) navSheet.current?.close(); }}>
        <button className="sheet-handle" aria-label="Close navigation" onClick={() => navSheet.current?.close()}><span/></button>{navigation}
      </dialog>
    </div>
  );
}
function smartDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } as const : {}) });
}
