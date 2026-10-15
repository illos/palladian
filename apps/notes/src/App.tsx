import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SessionController } from "./session";
import type {
  CachedNotebook,
  NoteBody,
  NoteRole,
  NoteSummary,
  NotesStore,
} from "./cache";
import { emptyDocument, validateCachedDocument } from "./document";
import { EditorSurface } from "./EditorSurface";
import { Icon } from "./Icons";
import { Appearance } from "./Appearance";
import type { ChannelStatus, NoteChannel } from "./channel";
import { liveStateSource, type LiveBox } from "./liveBox";
import type { SearchHit } from "./live";
import "./theme.css";
import "./styles.css";

const Panels = lazy(() => import("./panels"));

type OpenKind = "cached" | "draft" | "live" | "reader";
interface OpenNote extends NoteBody {
  kind: OpenKind;
  key: string;
  generation: number;
  role: NoteRole | null;
  trashed: boolean;
  channel: NoteChannel | null;
}
type Section =
  { kind: "all" } | { kind: "notebook"; id: string } | { kind: "trash" };
type Dialog =
  | { kind: "share"; noteId: string }
  | { kind: "move"; noteId: string }
  | { kind: "notebook"; notebookId: string | null }
  | null;
type SettingsTab = "appearance" | "agents" | "account";

const statusLabels = {
  connecting: "Connecting — cached notes remain available",
  ready: "Connected",
  retrying: "Reconnecting — cached notes remain available",
  expired: "Sign in again to reconnect — cached notes remain available",
  revoked: "Device access revoked",
  "signed-out": "Signed out",
};

function randomId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function channelLabel(status: ChannelStatus | null, ready: boolean) {
  if (!status) return "";
  switch (status.kind) {
    case "offline":
      if (status.pending) return "Offline — changes kept on this device";
      return ready ? "Offline" : "Cached copy — read only";
    case "syncing":
      return "Connecting…";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "blocked":
      return status.message;
  }
}

function routeNoteId() {
  const match = /^\/notes\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
  return match ? match[1]! : null;
}

export function App({
  session,
  store,
  liveBox,
}: {
  session: SessionController;
  store: NotesStore;
  liveBox: LiveBox;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const live = useSyncExternalStore(liveBox.subscribe, liveBox.get);
  const source = useMemo(() => liveStateSource(live), [live]);
  const liveState = useSyncExternalStore(source.subscribe, source.get);
  const [view, setView] = useState<"notes" | "settings">("notes");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [section, setSection] = useState<Section>({ kind: "all" });
  const [dialog, setDialog] = useState<Dialog>(null);
  const navSheet = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [notebooks, setNotebooks] = useState<CachedNotebook[]>([]);
  const [open, setOpen] = useState<OpenNote | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{
    accountId: string;
    generation: number;
    results: SearchHit[];
  } | null>(null);
  const [rowLimit, setRowLimit] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState(
    "Local draft — not saved to server",
  );
  const [channelStatus, setChannelStatus] = useState<ChannelStatus | null>(
    null,
  );
  const openRequest = useRef(0);
  const listRequest = useRef(0);
  const writeRequest = useRef(0);
  const pendingRoute = useRef(routeNoteId());
  const openKey = useRef<string | null>(null);
  openKey.current = open?.key ?? null;
  const openRef = useRef(open);
  openRef.current = open;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const accountId = snapshot.accountId;
  const permitted =
    accountId !== null &&
    snapshot.status !== "revoked" &&
    snapshot.status !== "signed-out";
  const liveReady =
    !!live && liveState.ready && liveState.accountId === accountId;
  const currentOpen = permitted && open?.accountId === accountId ? open : null;

  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);

  // Library rows and notebooks come from the local cache; the live layer fills it.
  useEffect(() => {
    let mounted = true;
    setRows([]);
    setNotebooks([]);
    setRowLimit(60);
    setOpen(null);
    setError(null);
    openRequest.current++;
    async function refresh() {
      const request = ++listRequest.current;
      if (!accountId || !permitted) return;
      try {
        const [result, books] = await Promise.all([
          store.list(accountId),
          store.notebooks(accountId),
        ]);
        if (
          mounted &&
          request === listRequest.current &&
          snapshotRef.current.accountId === accountId
        ) {
          setRows(result);
          setNotebooks(books);
        }
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
        setNotebooks([]);
        setOpen(null);
      }
      const shown = openRef.current;
      const revoked = !!shown && !!event.revokedNotes?.includes(shown.id);
      const held = !!shown && !!event.heldNotes?.includes(shown.id);
      if (event.accountId === accountId && shown && (revoked || held)) {
        shown.channel?.close();
        openRequest.current++;
        setOpen(null);
        setError(
          revoked
            ? "You no longer have access to that note."
            : "Checking your access to that note. Its unsaved changes are kept until the server answers.",
        );
      }
      void refresh();
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [accountId, permitted, store]);

  // Warm the editing modules once the server is reachable.
  useEffect(() => {
    if (liveReady) {
      void import("./channel");
      void import("@palladian/notes-core/document");
    }
  }, [liveReady]);

  // Open channels follow live availability without remounting the editor.
  const transport = liveReady ? live!.transport : null;
  useEffect(() => {
    currentOpen?.channel?.connect(transport);
  }, [currentOpen?.channel, transport]);

  // Background sync leaves the open note to its editor.
  useEffect(() => {
    if (!live || !currentOpen) return;
    const id = currentOpen.id;
    live.setOpen(id, true);
    return () => live.setOpen(id, false);
  }, [live, currentOpen?.id]);

  // Read-only notes follow the accepted document.
  useEffect(() => {
    if (!liveReady || currentOpen?.kind !== "reader") return;
    const key = currentOpen.key;
    const noteId = currentOpen.id;
    return live!.subscribeContent(noteId, (content) => {
      if (!content) {
        accessLost(noteId);
        return;
      }
      setOpen((prev) =>
        prev && prev.key === key && prev.revision !== content.revision
          ? { ...prev, document: content.doc, revision: content.revision }
          : prev,
      );
    });
  }, [liveReady, live, currentOpen?.kind, currentOpen?.id, currentOpen?.key]);

  // Server search complements instant local filtering. Results are fenced to
  // the account and session generation that asked for them.
  useEffect(() => {
    setHits(null);
    if (!liveReady || !accountId || query.trim().length < 2) return;
    const term = query;
    const generation = snapshot.generation;
    let current = true;
    const timer = setTimeout(() => {
      void live!
        .search(term)
        .then((results) => {
          if (
            current &&
            snapshotRef.current.accountId === accountId &&
            snapshotRef.current.generation === generation
          )
            setHits({ accountId, generation, results });
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [liveReady, live, query, accountId, snapshot.generation]);

  // A deep link opens its note once the library knows about it. Startup session
  // fences can discard an attempt, so keep trying until a note is shown.
  useEffect(() => {
    const id = pendingRoute.current;
    if (!id || !permitted) return;
    const row = rows.find((r) => r.id === id);
    if (row) void selectNote(row);
    else if (liveReady) {
      pendingRoute.current = null;
      void openRemote(id);
    }
  }, [rows, permitted, liveReady, snapshot.generation]);

  function closeOpen() {
    openRequest.current++;
    open?.channel?.close();
    setOpen(null);
    setChannelStatus(null);
    if (location.pathname !== "/") history.replaceState(null, "", "/");
  }

  function show(note: OpenNote) {
    pendingRoute.current = null;
    open?.channel?.close();
    setChannelStatus(null);
    openKey.current = note.key;
    setOpen(note);
    if (!note.id.startsWith("local-") && note.kind !== "draft")
      history.replaceState(null, "", "/notes/" + note.id);
    else if (location.pathname !== "/") history.replaceState(null, "", "/");
  }

  async function makeChannel(
    note: {
      id: string;
      created: boolean;
      baseDocument: string;
      baseRevision: number;
      clientId: string;
      pending: string[];
      notebookId?: string | undefined;
    },
    key: string,
  ) {
    const { NoteChannel } = await import("./channel");
    const channel: NoteChannel = new NoteChannel({
      store,
      accountId: accountId!,
      noteId: note.id,
      created: note.created,
      baseDocument: note.baseDocument,
      baseRevision: note.baseRevision,
      clientId: note.clientId,
      pending: note.pending,
      ...(note.notebookId ? { notebookId: note.notebookId } : {}),
      onStatus: (status) => {
        if (openKey.current === key) setChannelStatus(status);
      },
      onAccessLost: (noteId) => accessLost(noteId),
      onCreated: (noteId) => {
        setOpen((prev) => (prev?.key === key ? { ...prev, id: noteId } : prev));
        history.replaceState(null, "", "/notes/" + noteId);
      },
    });
    return channel;
  }

  /** The server says this account can no longer open the note: drop every copy. */
  function accessLost(noteId: string) {
    if (accountId)
      void store.revokeNotes(accountId, [noteId]).catch(() => undefined);
    const shown = openRef.current;
    if (shown?.id === noteId) {
      shown.channel?.close();
      openRequest.current++;
      setOpen(null);
    }
    setError("You no longer have access to that note.");
  }

  async function openRemote(noteId: string) {
    if (!live || !accountId) return;
    try {
      const content = await live.fetchContent(noteId);
      if (!content) {
        setError("This note is not available to you.");
        return;
      }
      const [{ parseStoredDoc }, { plainText }] = await Promise.all([
        import("@palladian/notes-core/document"),
        import("@palladian/notes-core/projection"),
      ]);
      const fence = await store.captureFence(accountId);
      await store.cacheAccepted(
        {
          accountId,
          id: noteId,
          document: content.doc,
          text: plainText(parseStoredDoc(content.doc)),
          revision: content.revision,
        },
        Date.now(),
        fence,
      );
      const row = (await store.list(accountId)).find((r) => r.id === noteId);
      if (row) await selectNote({ ...row, role: row.role ?? content.role });
    } catch {
      setError("This note could not be opened.");
    }
  }

  async function selectNote(row: NoteSummary) {
    setView("notes");
    if (currentOpen?.id === row.id) return;
    const request = ++openRequest.current;
    const generation = snapshot.generation;
    try {
      const [body, draft] = await Promise.all([
        store.read(row.accountId, row.id),
        store.readDraft(row.accountId, row.id),
      ]);
      if (
        request !== openRequest.current ||
        snapshotRef.current.accountId !== row.accountId ||
        snapshotRef.current.generation !== generation
      )
        return;
      if (!body) {
        if (liveReady) return void openRemote(row.id);
        setError("This note's text is not cached on this device yet.");
        return;
      }
      validateCachedDocument(body.document);
      setError(null);
      const base = {
        ...body,
        key: row.id,
        generation,
        role: row.role ?? null,
        trashed: !!row.trashed,
      };
      const baseRevision = draft?.baseRevision ?? body.revision;
      if (draft && draft.baseRevision === undefined) {
        show({ ...base, kind: "draft", channel: null });
        setSaveState("Local draft — not saved to server");
      } else if (row.role === "read") {
        show({ ...base, kind: "reader", channel: null });
      } else if (
        (row.role === "owner" || row.role === "edit") &&
        baseRevision !== undefined
      ) {
        const channel = await makeChannel(
          {
            id: row.id,
            created: draft?.created ?? true,
            baseDocument: draft?.baseDocument ?? body.document,
            baseRevision,
            clientId: draft?.clientId ?? randomId(),
            pending: draft?.steps ?? [],
            notebookId: draft?.notebookId ?? row.notebookId,
          },
          row.id,
        );
        if (request !== openRequest.current) return channel.close();
        // The editor starts from the accepted base and replays pending steps once.
        show({
          ...base,
          document: draft?.baseDocument ?? body.document,
          kind: "live",
          channel,
        });
      } else {
        show({ ...base, kind: "cached", channel: null });
      }
    } catch {
      setError("This note could not be opened from local storage.");
    }
  }

  async function createNote() {
    if (!accountId || !permitted) return;
    openRequest.current++;
    setView("notes");
    if (liveReady) {
      const { emptyDoc } = await import("@palladian/notes-core/document");
      const id = "local-" + randomId();
      const doc = JSON.stringify(emptyDoc().toJSON());
      const notebookId =
        section.kind === "notebook"
          ? section.id
          : (liveState.profile?.defaultNotebookId ?? undefined);
      const request = openRequest.current;
      const channel = await makeChannel(
        {
          id,
          created: false,
          baseDocument: doc,
          baseRevision: 0,
          clientId: randomId(),
          pending: [],
          notebookId,
        },
        id,
      );
      if (request !== openRequest.current) return channel.close();
      show({
        accountId,
        id,
        key: id,
        document: doc,
        text: "",
        revision: 0,
        kind: "live",
        generation: snapshot.generation,
        role: "owner",
        trashed: false,
        channel,
      });
      return;
    }
    const draft: OpenNote = {
      accountId,
      id: crypto.randomUUID(),
      key: "",
      document: emptyDocument(),
      text: "",
      kind: "draft",
      generation: snapshot.generation,
      role: null,
      trashed: false,
      channel: null,
    };
    draft.key = draft.id;
    show(draft); // Typing can start before IDB or authentication completes.
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
        ...(section.kind === "notebook" ? { notebookId: section.id } : {}),
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

  async function deleteForever(note: OpenNote) {
    if (!live) return;
    if (
      !confirm(
        "Delete this note permanently? Its entire history is removed and it cannot be restored.",
      )
    )
      return;
    try {
      await live.deleteForever(note.id);
      closeOpen();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "That change failed.",
      );
    }
  }

  async function toggleTrash(note: OpenNote) {
    if (!live) return;
    try {
      await live.trash(note.id, !note.trashed);
      if (!note.trashed) closeOpen();
      else
        setOpen((prev) =>
          prev?.key === note.key ? { ...prev, trashed: false } : prev,
        );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "That change failed.",
      );
    }
  }

  const visibleNotebookIds = new Set(notebooks.map((n) => n.id));
  const sectionRows = permitted
    ? rows.filter((row) => {
        if (row.accountId !== accountId) return false;
        if (section.kind === "trash") return !!row.trashed;
        if (section.kind === "notebook")
          return row.notebookId === section.id && !row.trashed;
        return true;
      })
    : [];
  const needle = query.toLocaleLowerCase();
  const visibleRows = sectionRows.filter((row) =>
    (row.title + " " + row.preview).toLocaleLowerCase().includes(needle),
  );
  const shownIds = new Set(visibleRows.map((r) => r.id));
  const extraHits =
    permitted &&
    hits &&
    hits.accountId === accountId &&
    hits.generation === snapshot.generation
      ? hits.results.filter((hit) => !shownIds.has(hit.summary.id))
      : [];
  const sectionTitle =
    section.kind === "trash"
      ? "Trash"
      : section.kind === "notebook"
        ? (notebooks.find((n) => n.id === section.id)?.name ?? "Notebook")
        : "All notes";
  const openRole = currentOpen?.role ?? null;
  const canEdit = openRole === "owner" || openRole === "edit";
  const editable =
    !!currentOpen &&
    (currentOpen.kind === "draft" ||
      (currentOpen.kind === "live" &&
        !currentOpen.trashed &&
        !!currentOpen.channel?.ready &&
        channelStatus?.kind !== "blocked"));
  const statusText = !currentOpen
    ? ""
    : currentOpen.kind === "draft"
      ? saveState
      : currentOpen.kind === "cached"
        ? "Cached copy — read only"
        : currentOpen.kind === "reader"
          ? liveReady
            ? "Read only"
            : "Cached copy — read only"
          : currentOpen.trashed
            ? "In Trash — restore to edit"
            : channelLabel(channelStatus, !!currentOpen.channel?.ready);
  const serverNote =
    !!currentOpen &&
    currentOpen.kind !== "draft" &&
    !currentOpen.id.startsWith("local-");

  function navigate(next: "notes" | "settings", tab?: SettingsTab) {
    setView(next);
    if (tab) setSettingsTab(tab);
    navSheet.current?.close();
  }
  function choose(next: Section) {
    setSection(next);
    setRowLimit(60);
    navigate("notes");
  }

  const navigation = (
    <>
      <div className="wordmark">palladian</div>
      <p className="nav-label">Collections</p>
      <button
        className={
          view === "notes" && section.kind === "all"
            ? "nav-item active"
            : "nav-item"
        }
        onClick={() => choose({ kind: "all" })}
      >
        <Icon name="notes" size={17} />
        <span>All Notes</span>
        <small>
          {permitted ? rows.filter((r) => r.accountId === accountId).length : 0}
        </small>
      </button>
      {(notebooks.length > 0 || liveReady) && (
        <p className="nav-label nav-label-row">
          Notebooks
          {liveReady && (
            <button
              className="nav-label-action"
              aria-label="New notebook"
              title="New notebook"
              onClick={() => setDialog({ kind: "notebook", notebookId: null })}
            >
              <Icon name="plus" size={14} />
            </button>
          )}
        </p>
      )}
      {notebooks.map((notebook) => (
        <button
          key={notebook.id}
          className={
            view === "notes" &&
            section.kind === "notebook" &&
            section.id === notebook.id
              ? "nav-item active"
              : "nav-item"
          }
          onClick={() => choose({ kind: "notebook", id: notebook.id })}
          title={
            notebook.role === "owner"
              ? notebook.name
              : `${notebook.name} — shared by ${notebook.ownerName}`
          }
        >
          <Icon name="notebook" size={17} />
          <span>{notebook.name}</span>
          {notebook.role !== "owner" && <small>Shared</small>}
        </button>
      ))}
      <button
        className={
          view === "notes" && section.kind === "trash"
            ? "nav-item active"
            : "nav-item"
        }
        onClick={() => choose({ kind: "trash" })}
      >
        <Icon name="trash" size={17} />
        <span>Trash</span>
      </button>
      <div className="nav-spacer" />
      <div className="nav-footer">
        <button
          className={view === "settings" ? "nav-item active" : "nav-item"}
          onClick={() => navigate("settings")}
        >
          <Icon name="settings" size={17} />
          <span>Settings</span>
        </button>
      </div>
    </>
  );

  const activeNotebook =
    section.kind === "notebook"
      ? notebooks.find((n) => n.id === section.id)
      : undefined;

  return (
    <div
      className={[
        "notes-app",
        currentOpen && "has-note",
        view === "settings" && "settings-view",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <aside className="navigation" aria-label="Navigation">
        {navigation}
      </aside>
      <aside className="library" aria-label="Notes library">
        <div className="library-notes" hidden={view !== "notes"}>
          <header className="library-header">
            <div>
              <h1>{sectionTitle}</h1>
              <p className="note-count">
                {visibleRows.length} notes
                {activeNotebook && liveReady && (
                  <>
                    {" · "}
                    <button
                      className="link-button"
                      onClick={() =>
                        setDialog({
                          kind: "notebook",
                          notebookId: activeNotebook.id,
                        })
                      }
                    >
                      {activeNotebook.role === "owner" ? "Sharing" : "Members"}
                    </button>
                  </>
                )}
              </p>
            </div>
            <button
              onClick={() => {
                void createNote();
              }}
              disabled={
                !permitted ||
                section.kind === "trash" ||
                (activeNotebook !== undefined && activeNotebook.role === "read")
              }
              aria-label="New note"
            >
              <Icon name="compose" size={21} />
            </button>
          </header>
          <label className="search">
            <Icon name="search" size={17} />
            <span className="sr-only">Search notes</span>
            <input
              ref={search}
              type="search"
              placeholder="Search notes…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setRowLimit(60);
              }}
            />
          </label>
          <div
            className="note-list"
            aria-label="Cached notes"
            onScroll={(event) => {
              const list = event.currentTarget;
              if (list.scrollHeight - list.scrollTop - list.clientHeight < 200)
                setRowLimit((limit) =>
                  Math.min(visibleRows.length, limit + 60),
                );
            }}
          >
            {visibleRows.slice(0, rowLimit).map((row) => (
              <button
                className={
                  currentOpen?.id === row.id ? "note-row selected" : "note-row"
                }
                key={row.id}
                onClick={() => {
                  void selectNote(row);
                }}
              >
                <strong>{row.title || "Untitled"}</strong>
                <span className="row-detail">
                  <time dateTime={new Date(row.updatedAt).toISOString()}>
                    {smartDate(row.updatedAt)}
                  </time>
                  <span className="row-preview">
                    {row.preview || "Empty note"}
                  </span>
                </span>
                {row.kind === "draft" && (
                  <small>{row.role ? "Unsaved changes" : "Local draft"}</small>
                )}
                {row.trashed && section.kind !== "trash" && (
                  <small>In Trash</small>
                )}
                {row.notebookId &&
                  !visibleNotebookIds.has(row.notebookId) &&
                  !row.trashed && <small>Shared with you</small>}
              </button>
            ))}
            {rowLimit < visibleRows.length && (
              <button
                className="show-more"
                onClick={() => setRowLimit((limit) => limit + 60)}
              >
                Show more notes
              </button>
            )}
            {extraHits.length > 0 && (
              <>
                <p className="nav-label">Matches in note text</p>
                {extraHits.map((hit) => (
                  <button
                    key={hit.summary.id}
                    className="note-row"
                    onClick={() => {
                      const row = rows.find((r) => r.id === hit.summary.id);
                      if (row) void selectNote(row);
                      else void openRemote(hit.summary.id);
                    }}
                  >
                    <strong>{hit.summary.title || "Untitled"}</strong>
                    <span className="row-detail">
                      <span className="row-preview">{hit.excerpt}</span>
                    </span>
                  </button>
                ))}
              </>
            )}
            {!visibleRows.length && !extraHits.length && (
              <p className="empty-list">
                {!permitted
                  ? "Connect an account to open its cached library."
                  : section.kind === "trash"
                    ? "Trash is empty."
                    : "No matching notes cached here yet."}
              </p>
            )}
          </div>
          <footer className="connection-footer">
            <p role="status" data-testid="session-status">
              {statusLabels[snapshot.status]}
              {snapshot.status === "ready" && live && !liveState.connected
                ? " — server unreachable"
                : ""}
            </p>
            {snapshot.error && <p>{snapshot.error}</p>}
            <details>
              <summary>Connection</summary>
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
            </details>
          </footer>
        </div>
        <div className="settings-rail" hidden={view !== "settings"}>
          <button className="settings-back" onClick={() => navigate("notes")}>
            <Icon name="back" size={15} />
            Notes
          </button>
          <h1>Settings</h1>
          <button
            className={
              settingsTab === "appearance"
                ? "settings-tab active"
                : "settings-tab"
            }
            aria-current={settingsTab === "appearance" ? "page" : undefined}
            onClick={() => setSettingsTab("appearance")}
          >
            <Icon name="sun" size={20} />
            Appearance
          </button>
          <button
            className={
              settingsTab === "agents" ? "settings-tab active" : "settings-tab"
            }
            aria-current={settingsTab === "agents" ? "page" : undefined}
            onClick={() => setSettingsTab("agents")}
            disabled={!liveReady}
          >
            <Icon name="agent" size={20} />
            Connected agents
          </button>
          <button
            className={
              settingsTab === "account" ? "settings-tab active" : "settings-tab"
            }
            aria-current={settingsTab === "account" ? "page" : undefined}
            onClick={() => setSettingsTab("account")}
            disabled={!liveReady}
          >
            <Icon name="user" size={20} />
            Account
          </button>
        </div>
        <div className="mobile-home-bar" hidden={view !== "notes"}>
          <button
            className="sheet-handle"
            aria-label="Open navigation"
            onClick={() => navSheet.current?.showModal()}
          >
            <span />
          </button>
          <div className="mobile-home-actions">
            <button
              aria-label="New note"
              onClick={() => {
                void createNote();
              }}
              disabled={!permitted || section.kind === "trash"}
            >
              <Icon name="compose" size={22} />
              <span>New</span>
            </button>
            <button onClick={() => navSheet.current?.showModal()}>
              <Icon name="menu" size={22} />
              <span>Menu</span>
            </button>
            <button onClick={() => search.current?.focus()}>
              <Icon name="search" size={22} />
              <span>Search</span>
            </button>
          </div>
        </div>
      </aside>
      <main className="note-surface">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <section className="note-content-region" hidden={view !== "notes"}>
          {currentOpen ? (
            <>
              <div className="note-toolbar">
                <button className="back-button" onClick={closeOpen}>
                  <Icon name="back" size={18} />
                  All notes
                </button>

                <button
                  className="mobile-note-menu"
                  aria-label="Open navigation"
                  onClick={() => navSheet.current?.showModal()}
                >
                  <Icon name="menu" size={20} />
                </button>
                <span className="save-status">{statusText}</span>
                {serverNote && liveReady && (
                  <span className="note-actions">
                    <button
                      className="icon-button"
                      aria-label="Share note"
                      title="Share"
                      onClick={() =>
                        setDialog({ kind: "share", noteId: currentOpen.id })
                      }
                    >
                      <Icon name="share" size={18} />
                    </button>
                    {openRole === "owner" && !currentOpen.trashed && (
                      <button
                        className="icon-button"
                        aria-label="Move to another notebook"
                        title="Move to another notebook"
                        onClick={() =>
                          setDialog({ kind: "move", noteId: currentOpen.id })
                        }
                      >
                        <Icon name="notebook" size={18} />
                      </button>
                    )}
                    {openRole === "owner" && currentOpen.trashed && (
                      <button
                        className="icon-button"
                        aria-label="Delete forever"
                        title="Delete forever"
                        onClick={() => void deleteForever(currentOpen)}
                      >
                        <Icon name="trash" size={18} />
                      </button>
                    )}
                    {canEdit && (
                      <button
                        className="icon-button"
                        aria-label={
                          currentOpen.trashed
                            ? "Restore note"
                            : "Move note to Trash"
                        }
                        title={
                          currentOpen.trashed ? "Restore" : "Move to Trash"
                        }
                        onClick={() => void toggleTrash(currentOpen)}
                      >
                        <Icon
                          name={currentOpen.trashed ? "restore" : "trash"}
                          size={18}
                        />
                      </button>
                    )}
                  </span>
                )}
              </div>
              <EditorSurface
                key={currentOpen.key + ":" + currentOpen.generation}
                editedLabel={
                  "Edited " +
                  smartDate(
                    rows.find((row) => row.id === currentOpen.id)?.updatedAt ??
                      Date.now(),
                  )
                }
                document={currentOpen.document}
                text={currentOpen.text}
                editable={editable}
                binding={currentOpen.channel ?? undefined}
                onChange={(document, text) => {
                  if (currentOpen.kind === "draft")
                    void persistDraft(currentOpen, document, text);
                }}
              />
            </>
          ) : (
            <div className="welcome">
              <p>Select a note to start reading.</p>
              <button
                disabled={!permitted}
                onClick={() => {
                  void createNote();
                }}
              >
                New note
              </button>
            </div>
          )}
        </section>
        <section className="appearance-region" hidden={view !== "settings"}>
          <header className="settings-pane-header">
            <button className="back-button" onClick={() => navigate("notes")}>
              <Icon name="back" size={18} />
              Notes
            </button>
            <h2>
              {settingsTab === "appearance"
                ? "Appearance"
                : settingsTab === "agents"
                  ? "Connected agents"
                  : "Account"}
            </h2>
          </header>
          <div className="settings-pane-body">
            {settingsTab === "appearance" ? (
              <Appearance />
            ) : live && liveReady ? (
              <Suspense fallback={<p>Loading…</p>}>
                <Panels
                  live={live}
                  panel={settingsTab}
                  session={session}
                  notebooks={notebooks}
                />
              </Suspense>
            ) : (
              <p>Connect to the server to manage this.</p>
            )}
          </div>
        </section>
      </main>
      {dialog && live && liveReady && (
        <Suspense fallback={null}>
          <Panels
            live={live}
            panel={dialog.kind}
            session={session}
            notebooks={notebooks}
            noteId={
              dialog.kind === "share" || dialog.kind === "move"
                ? dialog.noteId
                : undefined
            }
            notebookId={
              dialog.kind === "notebook"
                ? (dialog.notebookId ?? undefined)
                : undefined
            }
            onClose={() => setDialog(null)}
            onNotebookCreated={(id) => {
              setDialog(null);
              choose({ kind: "notebook", id });
            }}
          />
        </Suspense>
      )}
      <dialog
        ref={navSheet}
        className="mobile-nav-sheet"
        aria-label="Navigation"
        onClick={(event) => {
          if (event.target === event.currentTarget) navSheet.current?.close();
        }}
      >
        <button
          className="sheet-handle"
          aria-label="Close navigation"
          onClick={() => navSheet.current?.close()}
        >
          <span />
        </button>
        {navigation}
      </dialog>
    </div>
  );
}
function smartDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear()
      ? ({ year: "numeric" } as const)
      : {}),
  });
}
