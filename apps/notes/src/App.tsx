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
  Arrangement,
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
import { PanelBoundary } from "./PanelBoundary";
import { ActionMenu } from "./ActionMenu";
import { SwipeRow, actionIcons } from "./SwipeRow";
import { ToastHost, useToasts } from "./Toasts";
import {
  arrangeRows,
  orderEdit,
  orderOf,
  pinEdit,
  positionsEdit,
  settleEdits,
  withEdits,
  type ArrangementEdit,
  type ListOrder,
  type PendingEdit,
} from "./arrange";
import { dropIndex, placement } from "./reorder";
import {
  actionLabels,
  isLocalNoteId,
  noteActions,
  swipeLayout,
  type ActionId,
  type ActionTarget,
} from "./note-actions";
import {
  About,
  SessionControls,
  SettingsList,
  settingsLabel,
  settingsRoute,
  settingsTabs,
  type SettingsTab,
} from "./Settings";
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
  /** Counts each time a note is shown, so late results can tell openings apart. */
  opening: number;
  generation: number;
  role: NoteRole | null;
  trashed: boolean;
  channel: NoteChannel | null;
}
type Section =
  { kind: "all" } | { kind: "notebook"; id: string } | { kind: "trash" };
type Dialog =
  | { kind: "share"; noteId: string }
  | { kind: "move"; noteId: string; notebookId?: string }
  | { kind: "info"; noteId: string; text?: string }
  | { kind: "notebook"; notebookId: string | null }
  | null;
/** A note's actions menu: the long-press sheet, row menu or "…" menu. */
interface Menu {
  target: NoteTarget;
  /** A row in the list, or the open note's toolbar. */
  source: "row" | "open";
  actions: ActionId[];
  anchor: { x: number; y: number } | null;
  only?: ((action: ActionId) => boolean) | undefined;
}
interface NoteTarget extends ActionTarget {
  accountId: string;
  title: string;
  notebookId?: string | undefined;
}

/** Actions shown as buttons on an open note on wide screens; the rest are under "…". */
const toolbarIcons: ActionId[] = [
  "share",
  "move",
  "info",
  "restore",
  "trash",
  "delete",
];
const toolbarLabels: Partial<Record<ActionId, string>> = {
  share: "Share note",
  move: "Move to another notebook",
  info: "Note info",
  restore: "Restore note",
  trash: "Move note to Trash",
  delete: "Delete forever",
};

/** How far a swipe must travel to open or close the phone navigation sheet. */
const SHEET_SWIPE = 40;

/** The data type a note row carries when dragged onto a notebook (desktop). */
const NOTE_DRAG = "application/x-palladian-note";
/** Settings entries this tab pushed on top of the notes view. */
function settingsDepth(): number {
  const depth = (history.state as { settingsDepth?: unknown } | null)
    ?.settingsDepth;
  return typeof depth === "number" ? depth : 0;
}

const phoneQuery = "(max-width: 760px)";
function usePhone() {
  const [phone, setPhone] = useState(() => matchMedia(phoneQuery).matches);
  useEffect(() => {
    const query = matchMedia(phoneQuery);
    const changed = () => setPhone(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return phone;
}

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

/** The address of what the notes view shows: a saved note, or the library. */
function notePath(note: { id: string; kind: OpenKind } | null) {
  return note && !note.id.startsWith("local-") && note.kind !== "draft"
    ? "/notes/" + note.id
    : "/";
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
  const [view, setViewState] = useState<"notes" | "settings">(() =>
    settingsRoute(location.pathname) ? "settings" : "notes",
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  /**
   * Opening a note shows the notes. While Settings shows, a note that finishes
   * opening (a slow read or fetch begun earlier) opens behind it instead; its
   * address waits too (writeNotesPath). Leaving Settings uses setViewState.
   */
  function setView(next: "notes") {
    if (viewRef.current !== "settings") setViewState(next);
  }
  // Null is the phone's Settings list; wide screens show Account instead.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(
    () => settingsRoute(location.pathname)?.tab ?? null,
  );
  const phone = usePhone();
  const shownTab = settingsTab ?? (phone ? null : "account");
  const [section, setSection] = useState<Section>({ kind: "all" });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  /** The note row resting open after a swipe; one at a time. */
  const [openSwipe, setOpenSwipe] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const sheetGesture = useRef<number | null>(null);
  const noteList = useRef<HTMLDivElement>(null);
  /** Where a dragged note would land, as a line in the list (custom order). */
  const [reorderLine, setReorderLine] = useState<number | null>(null);
  const { toasts, show: toast, dismiss: dismissToast } = useToasts();
  const navSheet = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<NoteSummary[]>([]);
  /** This person's pins, sort orders and custom positions (D102). */
  // Pins and orders as last synced, plus changes the server has not
  // confirmed yet (shown on top, never written to the device cache).
  const [savedArrangement, setSavedArrangement] = useState<Arrangement | null>(
    null,
  );
  const savedArrangementRef = useRef(savedArrangement);
  savedArrangementRef.current = savedArrangement;
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>([]);
  const editCount = useRef(0);
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
  /** The note an unfinished open is for; losing access to it cancels the open. */
  const pendingOpen = useRef<string | null>(null);
  /** Counts revocations and holds, so pending search results can be refenced. */
  const accessEvents = useRef(0);
  const listRequest = useRef(0);
  const writeRequest = useRef(0);
  const pendingRoute = useRef(routeNoteId());
  /** Bumped when Back or Forward lands on a note the app should open. */
  const [routeTick, setRouteTick] = useState(0);
  /**
   * A notes address that changed while Settings was showing; it is applied
   * once the notes are shown again rather than over the Settings entry.
   */
  const deferredNotesPath = useRef<string | null>(null);
  const openKey = useRef<string | null>(null);
  const openings = useRef(0);
  openKey.current = open?.key ?? null;
  const openRef = useRef(open);
  openRef.current = open;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const liveRef = useRef(live);
  liveRef.current = live;
  const accountId = snapshot.accountId;
  // Unconfirmed changes show only in the account they were made in.
  const arrangement = withEdits(
    savedArrangement,
    pendingEdits
      .filter((pending) => pending.accountId === accountId)
      .map((pending) => pending.edit),
  );
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

  // Back and Forward move between the notes and Settings without closing the
  // open note.
  useEffect(() => {
    const moved = () => {
      const route = settingsRoute(location.pathname);
      setViewState(route ? "settings" : "notes");
      if (route) return setSettingsTab(route.tab);
      // Back on the notes, the address follows what is shown, or what is
      // shown follows the address when the shown note has gone (a reload in
      // Settings, for example).
      if (deferredNotesPath.current !== null) {
        history.replaceState(null, "", deferredNotesPath.current);
        deferredNotesPath.current = null;
        return;
      }
      const shown = notePath(openRef.current);
      if (location.pathname === shown) return;
      const id = routeNoteId();
      if (id) {
        pendingRoute.current = id;
        setRouteTick((tick) => tick + 1);
      } else history.replaceState(null, "", shown);
    };
    addEventListener("popstate", moved);
    return () => removeEventListener("popstate", moved);
  }, []);

  // Library rows and notebooks come from the local cache; the live layer fills it.
  useEffect(() => {
    let mounted = true;
    setRows([]);
    setNotebooks([]);
    setSavedArrangement(null);
    setPendingEdits([]);
    setRowLimit(60);
    setOpen(null);
    setError(null);
    openRequest.current++;
    async function refresh() {
      const request = ++listRequest.current;
      if (!accountId || !permitted) return;
      try {
        const [result, books, arranged] = await Promise.all([
          store.list(accountId),
          store.notebooks(accountId),
          store.arrangement(accountId),
        ]);
        if (
          mounted &&
          request === listRequest.current &&
          snapshotRef.current.accountId === accountId
        ) {
          setRows(result);
          setNotebooks(books);
          setSavedArrangement(arranged);
          // Confirmed changes give way once the synced copy includes them.
          setPendingEdits((edits) => settleEdits(edits, arranged));
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
      const fenced = [
        ...(event.revokedNotes ?? []),
        ...(event.heldNotes ?? []),
      ];
      if (fenced.length && event.accountId === accountId) {
        accessEvents.current++;
        setHits((previous) =>
          previous
            ? {
                ...previous,
                results: previous.results.filter(
                  (hit) => !fenced.includes(hit.summary.id),
                ),
              }
            : previous,
        );
      }
      const pending = pendingOpen.current;
      if (
        pending &&
        event.accountId === accountId &&
        (event.revokedNotes?.includes(pending) ||
          event.heldNotes?.includes(pending))
      ) {
        pendingOpen.current = null;
        openRequest.current++;
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
  // the account and session generation that asked for them, and to notes not
  // revoked or held on this device.
  useEffect(() => {
    setHits(null);
    if (!liveReady || !accountId || query.trim().length < 2) return;
    const term = query;
    const generation = snapshot.generation;
    let current = true;
    const timer = setTimeout(() => {
      void live!
        .search(term)
        .then(async (results) => {
          let fenced: Set<string>;
          let seen: number;
          do {
            seen = accessEvents.current;
            fenced = await store.fencedNotes(
              accountId,
              results.map((hit) => hit.summary.id),
            );
          } while (seen !== accessEvents.current);
          if (
            current &&
            snapshotRef.current.accountId === accountId &&
            snapshotRef.current.generation === generation
          )
            setHits({
              accountId,
              generation,
              results: results.filter((hit) => !fenced.has(hit.summary.id)),
            });
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [liveReady, live, query, accountId, snapshot.generation, store]);

  // A deep link opens its note once the library knows about it. Startup session
  // fences can discard an attempt, so keep trying until a note is shown. Not
  // while Settings shows: opening a note would leave it; Back resumes it.
  useEffect(() => {
    const id = pendingRoute.current;
    if (!id || !permitted || view !== "notes") return;
    const row = rows.find((r) => r.id === id);
    if (row) void selectNote(row);
    else if (liveReady) {
      pendingRoute.current = null;
      void openRemote(id);
    }
  }, [rows, permitted, liveReady, snapshot.generation, routeTick, view]);

  /** Address the notes view, unless Settings is showing (see deferredNotesPath). */
  function writeNotesPath(path: string) {
    if (settingsRoute(location.pathname)) deferredNotesPath.current = path;
    else if (location.pathname !== path) history.replaceState(null, "", path);
  }

  function closeOpen() {
    openRequest.current++;
    open?.channel?.close();
    setOpen(null);
    setChannelStatus(null);
    writeNotesPath("/");
  }

  function show(note: Omit<OpenNote, "opening">) {
    pendingRoute.current = null;
    open?.channel?.close();
    setChannelStatus(null);
    openKey.current = note.key;
    setOpen({ ...note, opening: ++openings.current });
    writeNotesPath(notePath(note));
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
        if (openKey.current === key) writeNotesPath("/notes/" + noteId);
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
    pendingOpen.current = row.id;
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
    } finally {
      if (request === openRequest.current) pendingOpen.current = null;
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
    const draft: Omit<OpenNote, "opening"> = {
      accountId,
      id: "local-" + randomId(),
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

  async function persistDraft(
    note: Pick<OpenNote, "accountId" | "id">,
    document: string,
    text: string,
  ) {
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

  const pinnedIds = new Set((arrangement?.pins ?? []).map((pin) => pin.noteId));

  /**
   * The account and session an action starts in. A slow action (a lazy
   * import, several writes) checks it before changing anything, so it never
   * lands in an account the person switched to meanwhile.
   */
  function sessionTicket() {
    const at = { accountId, generation: snapshotRef.current.generation, live };
    return () =>
      !!at.accountId &&
      !!at.live &&
      snapshotRef.current.accountId === at.accountId &&
      snapshotRef.current.generation === at.generation &&
      liveRef.current === at.live;
  }

  /**
   * Show a change at once, then save it. Until the synced arrangement
   * includes it, it is shown on top; a failed save removes it again, and it
   * expires after 30 seconds in any case.
   */
  async function rearrange(
    edit: ArrangementEdit,
    current: () => boolean,
    save: (
      client: NonNullable<typeof live>["client"],
      current: () => boolean,
    ) => Promise<void>,
  ) {
    const client = liveRef.current?.client;
    if (!current() || !client || !accountId) return;
    const id = ++editCount.current;
    setPendingEdits((edits) => [
      ...edits,
      { id, accountId, edit, confirmed: false },
    ]);
    const drop = () =>
      setPendingEdits((edits) => edits.filter((pending) => pending.id !== id));
    setTimeout(drop, 30_000);
    try {
      await save(client, current);
    } catch (failure) {
      drop();
      throw failure;
    }
    setPendingEdits((edits) =>
      settleEdits(
        edits.map((pending) =>
          pending.id === id ? { ...pending, confirmed: true } : pending,
        ),
        savedArrangementRef.current,
      ),
    );
  }

  async function changeOrder(list: string, order: ListOrder) {
    const current = sessionTicket();
    try {
      const { setOrder } = await import("./note-tools");
      await rearrange(orderEdit(list, order), current, (client) =>
        setOrder(client, list, order),
      );
    } catch (failure) {
      failed(failure);
    }
  }

  /**
   * Put `noteId` just before `beforeId` (null: last) among the notebook's other
   * unpinned notes, as they are now.
   */
  async function reorder(
    notebookId: string,
    noteId: string,
    beforeId: string | null,
  ) {
    const keys = new Map(
      (arrangement?.positions ?? [])
        .filter((p) => p.notebookId === notebookId)
        .map((p) => [p.noteId, p.key]),
    );
    const others = reorderable
      .filter((row) => row.id !== noteId)
      .map((row) => ({ id: row.id, key: keys.get(row.id) }));
    const index =
      beforeId === null
        ? others.length
        : others.findIndex((row) => row.id === beforeId);
    // The note it was dropped by has left the list meanwhile.
    if (index < 0) return;
    const current = sessionTicket();
    try {
      const writes = placement(others, index, noteId);
      const { setPositions } = await import("./note-tools");
      await rearrange(
        positionsEdit(notebookId, writes),
        current,
        (client, stillCurrent) =>
          setPositions(client, notebookId, writes, stillCurrent),
      );
    } catch (failure) {
      failed(failure);
    }
  }
  // A drag outlives the render it started in; it drops with the latest list.
  const reorderRef = useRef(reorder);
  reorderRef.current = reorder;

  /** Drag a note by its handle to a new place (mouse, pen or touch). */
  function startDrag(
    event: React.PointerEvent<HTMLElement>,
    noteId: string,
    notebookId: string,
  ) {
    const list = noteList.current;
    const handle = event.currentTarget;
    const moved = handle.closest<HTMLElement>(".note-row-wrap");
    if (!list || !moved || event.button !== 0) return;
    // The rows on screen; a long list renders its first rows only.
    const others = [
      ...list.querySelectorAll<HTMLElement>(".note-row-wrap[data-reorder]"),
    ].filter((element) => element !== moved);
    const shownIds = others.map((element) => element.dataset.noteId ?? "");
    // Every other note that can move, rendered or not, in list order.
    const allIds = reorderable
      .filter((row) => row.id !== noteId)
      .map((row) => row.id);
    if (shownIds.some((id) => !allIds.includes(id))) return;
    event.preventDefault();
    const pointer = event.pointerId;
    handle.setPointerCapture(pointer);
    /** The note a drop at `index` among the rendered rows lands before. */
    const beforeAt = (index: number) => {
      if (index < shownIds.length) return shownIds[index]!;
      const last = shownIds.at(-1);
      return last === undefined
        ? (allIds[0] ?? null)
        : (allIds[allIds.indexOf(last) + 1] ?? null);
    };
    const middles = others.map((el) => el.offsetTop + el.offsetHeight / 2);
    const contentY = (clientY: number) =>
      clientY - list.getBoundingClientRect().top + list.scrollTop;
    const start = contentY(event.clientY);
    const from = others.filter((el) => el.offsetTop < moved.offsetTop).length;
    let index = from;
    moved.classList.add("reordering");
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      const box = list.getBoundingClientRect();
      // Scroll while dragging near the top or bottom edge.
      if (e.clientY < box.top + 40) list.scrollTop -= 12;
      else if (e.clientY > box.bottom - 40) list.scrollTop += 12;
      const y = contentY(e.clientY);
      moved.style.transform = `translateY(${y - start}px)`;
      index = dropIndex(middles, y);
      setReorderLine(
        index < others.length
          ? others[index]!.offsetTop
          : (others.at(-1)?.offsetTop ?? 0) +
              (others.at(-1)?.offsetHeight ?? 0),
      );
    };
    // Listen on the window: if a sync update re-renders the handle mid-drag,
    // it loses the pointer capture, but the release still ends the drag.
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      moved.classList.remove("reordering");
      moved.style.transform = "";
      setReorderLine(null);
      if (commit && index !== from)
        void reorderRef.current(notebookId, noteId, beforeAt(index));
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === pointer) finish(true);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointer) finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  function targetOf(note: {
    accountId: string;
    id: string;
    title?: string;
    kind: string;
    role?: NoteRole | null | undefined;
    trashed?: boolean | undefined;
    notebookId?: string | undefined;
  }): NoteTarget {
    return {
      accountId: note.accountId,
      id: note.id,
      title: note.title || "Untitled",
      // A server note with unsent edits is still a server note.
      local: isLocalNoteId(note.id),
      pinned: pinnedIds.has(note.id),
      role: note.role,
      trashed: !!note.trashed,
      notebookId: note.notebookId,
    };
  }

  function openMenu(
    target: NoteTarget,
    source: Menu["source"],
    anchor: { x: number; y: number } | null,
    only?: (action: ActionId) => boolean,
  ) {
    const actions = noteActions(target, liveReady).filter(
      (action) => !only || only(action),
    );
    if (actions.length) setMenu({ target, source, actions, anchor, only });
  }

  /**
   * The note as it is now, from its row or the open note: roles, Trash and
   * the connection can change while a menu is open or a swipe rests open.
   */
  function currentTarget(
    id: string,
    source: Menu["source"] = "row",
  ): NoteTarget | null {
    const row = rows.find((r) => r.accountId === accountId && r.id === id);
    if (source === "row" && row) return targetOf(row);
    return openTarget?.id === id ? openTarget : row ? targetOf(row) : null;
  }

  /**
   * What the open note shows now: the editor's content including unsaved
   * typing, or for a note without an editor channel (a reader's view, which
   * live updates replace), its current document.
   */
  async function openContent(): Promise<{
    document: string;
    text: string;
  } | null> {
    const shown = openRef.current;
    if (!shown) return null;
    const current = shown.channel?.current();
    if (current) return current;
    const [{ parseStoredDoc }, { plainText }] = await Promise.all([
      import("@palladian/notes-core/document"),
      import("@palladian/notes-core/projection"),
    ]);
    return {
      document: shown.document,
      text: plainText(parseStoredDoc(shown.document)),
    };
  }

  /** The note's document, from the open editor, the cache or the server. */
  async function documentOf(target: NoteTarget): Promise<string | null> {
    const shown = openRef.current;
    if (shown?.id === target.id) return (await openContent())!.document;
    const body = await store.read(target.accountId, target.id);
    if (body) return body.document;
    if (!live || !liveReady) return null;
    return (await live.fetchContent(target.id))?.doc ?? null;
  }

  function failed(failure: unknown) {
    toast(
      failure instanceof Error && failure.message
        ? failure.message
        : "That did not work. Try again.",
    );
  }

  async function runAction(
    action: ActionId,
    target: NoteTarget,
    source: Menu["source"] = "row",
  ) {
    setOpenSwipe(null);
    // Act only if the note still offers this action to this person now.
    const now = currentTarget(target.id, source);
    if (
      !now ||
      now.accountId !== accountId ||
      !noteActions(now, liveReady).includes(action)
    )
      return toast("That action is no longer available for this note.");
    target = now;
    // The opening of this note on screen, if any. Other notes, or this note
    // again, may open while the action runs; only this opening is affected.
    const shownOpening =
      openRef.current?.id === target.id ? openRef.current.opening : null;
    const closeShown = () => {
      if (shownOpening !== null && openRef.current?.opening === shownOpening) {
        openRef.current.channel?.close();
        closeOpen();
      }
    };
    try {
      switch (action) {
        case "share":
          return setDialog({ kind: "share", noteId: target.id });
        case "move":
          return setDialog({ kind: "move", noteId: target.id });
        case "info": {
          const text =
            shownOpening !== null
              ? (await openContent())?.text
              : (await store.read(target.accountId, target.id))?.text;
          return setDialog({
            kind: "info",
            noteId: target.id,
            ...(text !== undefined ? { text } : {}),
          });
        }
        case "export":
        case "print": {
          const doc = await documentOf(target);
          if (!doc) return toast("This note's text is not on this device yet.");
          const tools = await import("./note-tools");
          if (action === "export")
            return tools.downloadMarkdown(target.title, doc);
          if (!tools.printNote(target.title, doc))
            toast(
              "The installed app cannot print. Open Palladian in Safari to print or save a PDF.",
            );
          return;
        }
        case "pin":
        case "unpin": {
          const pinned = action === "pin";
          const current = sessionTicket();
          const { setPin } = await import("./note-tools");
          await rearrange(
            pinEdit(target.id, pinned, Date.now()),
            current,
            (client) => setPin(client, target.id, pinned),
          );
          return toast(pinned ? "Pinned" : "Unpinned");
        }
        case "duplicate": {
          if (!live) return;
          const doc = await documentOf(target);
          if (!doc) return toast("This note's text is not on this device yet.");
          // The copy stays in the same notebook if you can add notes there.
          const book = notebooks.find((n) => n.id === target.notebookId);
          const notebookId =
            book && book.role !== "read"
              ? book.id
              : (liveState.profile?.defaultNotebookId ?? undefined);
          const { duplicateNote } = await import("./note-tools");
          const id = await duplicateNote(live.client, doc, notebookId);
          return toast("Duplicated", {
            label: "Open",
            run: () => void openRemote(id),
          });
        }
        case "trash": {
          if (!live) return;
          // Close the open note first: closing journals its latest typing
          // while the note can still be saved, and stops further edits.
          closeShown();
          await live.trash(target.id, true);
          return toast("Moved to Trash", {
            label: "Undo",
            run: () =>
              void live
                .trash(target.id, false)
                .catch((failure) => failed(failure)),
          });
        }
        case "restore": {
          if (!live) return;
          await live.trash(target.id, false);
          if (shownOpening !== null)
            setOpen((prev) =>
              prev?.opening === shownOpening
                ? { ...prev, trashed: false }
                : prev,
            );
          return toast("Restored");
        }
        case "delete": {
          if (!live) return;
          if (
            !confirm(
              `Delete “${target.title}” forever? Its entire history is removed and it cannot be restored.`,
            )
          )
            return;
          await live.deleteForever(target.id);
          closeShown();
          return toast("Deleted forever");
        }
      }
    } catch (failure) {
      failed(failure);
    }
  }

  /** Delete every note you own in Trash, one at a time. */
  async function emptyTrash(targets: NoteTarget[]) {
    if (!live || !targets.length) return;
    if (
      !confirm(
        targets.length === 1
          ? "Delete the note in Trash forever? Its history is removed too."
          : `Delete all ${targets.length} notes in Trash forever? Their history is removed too.`,
      )
    )
      return;
    let deleted = 0;
    for (const target of targets) {
      try {
        await live.deleteForever(target.id);
        deleted++;
        if (openRef.current?.id === target.id) {
          openRef.current.channel?.close();
          closeOpen();
        }
      } catch {
        // Counted below; the rest still go.
      }
    }
    toast(
      deleted === targets.length
        ? `Deleted ${deleted} ${deleted === 1 ? "note" : "notes"} forever`
        : `Deleted ${deleted} of ${targets.length} notes; try again for the rest.`,
    );
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
  /** All Notes ("all") or the notebook; Trash keeps last-edited order. */
  const listKey =
    section.kind === "all"
      ? "all"
      : section.kind === "notebook"
        ? section.id
        : null;
  const listOrder = listKey ? orderOf(arrangement, listKey) : "edited";
  const orderedRows = listKey
    ? arrangeRows(sectionRows, arrangement, listKey, { pins: true })
    : sectionRows;
  const visibleRows = orderedRows.filter((row) =>
    (row.title + " " + row.preview).toLocaleLowerCase().includes(needle),
  );
  /** Custom order: notes dragged into place; pinned notes stay on top. */
  const canReorder =
    section.kind === "notebook" &&
    listOrder === "custom" &&
    liveReady &&
    !query.trim();
  const reorderable = canReorder
    ? visibleRows.filter(
        (row) => !pinnedIds.has(row.id) && !targetOf(row).local,
      )
    : [];
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
  const sessionStatus =
    statusLabels[snapshot.status] +
    (snapshot.status === "ready" && live && !liveState.connected
      ? " — server unreachable"
      : "");
  // The open note's actions follow its row: the row has the current role and
  // Trash state, which may have changed since the note was opened.
  const openRow = currentOpen
    ? rows.find(
        (row) => row.accountId === accountId && row.id === currentOpen.id,
      )
    : undefined;
  const openTarget = currentOpen
    ? {
        ...targetOf({
          ...currentOpen,
          ...(openRow ? { role: openRow.role, trashed: openRow.trashed } : {}),
          title: openRow?.title ?? "",
          notebookId: openRow?.notebookId,
        }),
        // A plain local draft view has no server actions.
        ...(currentOpen.kind === "draft" ? { local: true } : {}),
      }
    : null;
  const openActions = openTarget ? noteActions(openTarget, liveReady) : [];
  // An open menu closes if the note's actions change under it (a role or
  // Trash change, the connection), rather than offering stale ones.
  const menuNow = menu ? currentTarget(menu.target.id, menu.source) : null;
  const menuStale =
    !!menu &&
    (!menuNow ||
      noteActions(menuNow, liveReady)
        .filter((action) => !menu.only || menu.only(action))
        .join() !== menu.actions.join());
  useEffect(() => {
    if (menuStale) setMenu(null);
  }, [menuStale]);
  const ownTrash =
    section.kind === "trash"
      ? sectionRows.filter((row) => row.role === "owner").map(targetOf)
      : [];
  const retention = liveState.profile?.trashRetentionDays;

  /** Settings opens as a history entry, so Back returns to the notes. */
  function openSettings(tab: SettingsTab | null) {
    const depth = view === "settings" ? settingsDepth() + 1 : 1;
    history.pushState(
      { settingsDepth: depth },
      "",
      tab ? "/settings/" + tab : "/settings",
    );
    setViewState("settings");
    setSettingsTab(tab);
    navSheet.current?.close();
  }
  /** Wide screens switch tabs in place; the phone list pushes each tab. */
  function selectTab(tab: SettingsTab) {
    if (phone) return openSettings(tab);
    history.replaceState(history.state, "", "/settings/" + tab);
    setSettingsTab(tab);
  }
  /** The phone's "‹ Settings": back to the list it came from. */
  function settingsHome() {
    if (settingsDepth() >= 2) return history.back();
    history.replaceState({ settingsDepth: settingsDepth() }, "", "/settings");
    setSettingsTab(null);
  }
  function leaveSettings() {
    navSheet.current?.close();
    if (view !== "settings") return;
    const depth = settingsDepth();
    if (depth > 0) return history.go(-depth);
    // Opened from a Settings link: replace it with the notes address.
    const path = deferredNotesPath.current ?? notePath(openRef.current);
    deferredNotesPath.current = null;
    history.replaceState(null, "", path);
    setViewState("notes");
  }
  function choose(next: Section) {
    setSection(next);
    setRowLimit(60);
    leaveSettings();
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
          onDragOver={(event) => {
            if (!liveReady || !event.dataTransfer.types.includes(NOTE_DRAG))
              return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(notebook.id);
          }}
          onDragLeave={() =>
            setDropTarget((current) =>
              current === notebook.id ? null : current,
            )
          }
          onDrop={(event) => {
            const noteId = event.dataTransfer.getData(NOTE_DRAG);
            setDropTarget(null);
            if (!noteId) return;
            event.preventDefault();
            setDialog({ kind: "move", noteId, notebookId: notebook.id });
          }}
          data-drop={dropTarget === notebook.id ? "" : undefined}
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
          onClick={() =>
            view === "settings"
              ? navSheet.current?.close()
              : openSettings(phone ? null : "account")
          }
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
              {section.kind === "trash" && retention !== undefined && (
                <p className="trash-policy">
                  {retention === 0
                    ? "Your notes stay in Trash until you delete them."
                    : `Your notes in Trash are deleted forever after ${
                        retention === 1
                          ? "1 day"
                          : retention === 7
                            ? "1 week"
                            : `${retention} days`
                      }.`}
                </p>
              )}
              {listKey && (
                <label className="sort-control">
                  <span>Sort</span>
                  <select
                    aria-label="Sort notes"
                    value={listOrder}
                    disabled={!liveReady}
                    onChange={(event) =>
                      void changeOrder(listKey, event.target.value as ListOrder)
                    }
                  >
                    <option value="edited">Last edited</option>
                    <option value="alpha">Alphabetical</option>
                    <option value="created">Date created</option>
                    {section.kind === "notebook" && (
                      <option value="custom">Custom order</option>
                    )}
                  </select>
                </label>
              )}
              <p className="note-count">
                {visibleRows.length} notes
                {section.kind === "trash" &&
                  liveReady &&
                  ownTrash.length > 0 && (
                    <>
                      {" · "}
                      <button
                        className="link-button"
                        onClick={() => void emptyTrash(ownTrash)}
                      >
                        Empty Trash
                      </button>
                    </>
                  )}
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
            ref={noteList}
            className="note-list"
            aria-label="Cached notes"
            onScroll={(event) => {
              const list = event.currentTarget;
              // Only ever grows: a scroll event while the list is briefly
              // empty (switching lists) once set it to 0, hiding every row.
              if (list.scrollHeight - list.scrollTop - list.clientHeight < 200)
                setRowLimit((limit) =>
                  Math.max(limit, Math.min(visibleRows.length, limit + 60)),
                );
            }}
          >
            {visibleRows.slice(0, rowLimit).map((row) => {
              const target = targetOf(row);
              const actions = noteActions(target, liveReady);
              const book =
                section.kind === "all" && row.notebookId && !row.trashed
                  ? notebooks.find((n) => n.id === row.notebookId)
                  : undefined;
              const draggable =
                !phone && liveReady && row.role === "owner" && !row.trashed;
              return (
                <div
                  className="note-row-wrap"
                  key={row.id}
                  data-reorder={
                    reorderable.some((r) => r.id === row.id) ? "" : undefined
                  }
                  data-note-id={row.id}
                >
                  <SwipeRow
                    layout={swipeLayout(target, liveReady)}
                    open={openSwipe === row.id}
                    onOpenChange={(open) =>
                      setOpenSwipe((current) =>
                        open ? row.id : current === row.id ? null : current,
                      )
                    }
                    onAction={(action) => void runAction(action, target)}
                    onLongPress={() => openMenu(target, "row", null)}
                    onMenu={(anchor) => openMenu(target, "row", anchor)}
                  >
                    <button
                      className={
                        currentOpen?.id === row.id
                          ? "note-row selected"
                          : "note-row"
                      }
                      draggable={draggable}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(NOTE_DRAG, row.id);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => {
                        void selectNote(row);
                      }}
                    >
                      <strong>
                        {pinnedIds.has(row.id) && (
                          <span className="row-pin" title="Pinned">
                            <Icon name="pin" size={13} />
                          </span>
                        )}
                        {row.title || "Untitled"}
                      </strong>
                      <span className="row-detail">
                        <time dateTime={new Date(row.updatedAt).toISOString()}>
                          {smartDate(row.updatedAt)}
                        </time>
                        <span className="row-preview">
                          {row.preview || "Empty note"}
                        </span>
                      </span>
                      {row.kind === "draft" && (
                        <small>
                          {row.role ? "Unsaved changes" : "Local draft"}
                        </small>
                      )}
                      {row.trashed && section.kind !== "trash" && (
                        <small>In Trash</small>
                      )}
                      {book && (
                        <small className="row-notebook">{book.name}</small>
                      )}
                      {row.notebookId &&
                        !visibleNotebookIds.has(row.notebookId) &&
                        !row.trashed && <small>Shared with you</small>}
                    </button>
                  </SwipeRow>
                  {actions.length > 0 && (
                    <button
                      type="button"
                      className="row-more"
                      // A pointer shortcut only: keyboards open the same menu
                      // from the row with the context-menu key, and the row
                      // stays the one button per note for assistive tech.
                      aria-hidden="true"
                      tabIndex={-1}
                      title="Actions"
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        openMenu(target, "row", {
                          x: box.left,
                          y: box.bottom,
                        });
                      }}
                    >
                      <Icon name="more" size={18} />
                    </button>
                  )}
                  {canReorder &&
                    section.kind === "notebook" &&
                    reorderable.some((r) => r.id === row.id) && (
                      <button
                        type="button"
                        className="reorder-handle"
                        aria-label={`Reorder ${row.title || "Untitled"}`}
                        title="Drag to reorder; arrow keys move it"
                        onPointerDown={(event) =>
                          startDrag(event, row.id, section.id)
                        }
                        onKeyDown={(event) => {
                          if (
                            event.key !== "ArrowUp" &&
                            event.key !== "ArrowDown"
                          )
                            return;
                          event.preventDefault();
                          const at = reorderable.findIndex(
                            (r) => r.id === row.id,
                          );
                          // Up: before the note above. Down: before the one
                          // after the note below, or last.
                          const to = event.key === "ArrowUp" ? at - 1 : at + 2;
                          if (to < 0 || to > reorderable.length) return;
                          void reorder(
                            section.id,
                            row.id,
                            reorderable[to]?.id ?? null,
                          );
                        }}
                      >
                        <Icon name="grip" size={18} />
                      </button>
                    )}
                </div>
              );
            })}
            {reorderLine !== null && (
              <div className="reorder-line" style={{ top: reorderLine }} />
            )}
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
            <button
              type="button"
              className="connection-status"
              title="Account and connection settings"
              onClick={() => openSettings("account")}
            >
              <span role="status" data-testid="session-status">
                {sessionStatus}
              </span>
            </button>
            {snapshot.error && <p>{snapshot.error}</p>}
          </footer>
        </div>
        <div className="settings-rail" hidden={view !== "settings"}>
          <button className="settings-back" onClick={leaveSettings}>
            <Icon name="back" size={15} />
            Notes
          </button>
          <h1>Settings</h1>
          {settingsTabs.map((tab) => (
            <button
              key={tab.id}
              className={
                shownTab === tab.id ? "settings-tab active" : "settings-tab"
              }
              aria-current={shownTab === tab.id ? "page" : undefined}
              onClick={() => selectTab(tab.id)}
            >
              <Icon name={tab.icon} size={20} />
              {tab.label}
            </button>
          ))}
        </div>
        <div
          className="mobile-home-bar"
          hidden={view !== "notes"}
          // Touch events, not pointer events: a vertical drag becomes a
          // scroll gesture, which cancels the pointer before it ends.
          onTouchStart={(event) => {
            sheetGesture.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchEnd={(event) => {
            // A swipe up from the bottom bar opens the navigation sheet.
            const start = sheetGesture.current;
            const end = event.changedTouches[0]?.clientY;
            sheetGesture.current = null;
            if (
              start !== null &&
              end !== undefined &&
              start - end > SHEET_SWIPE
            )
              navSheet.current?.showModal();
          }}
        >
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
                {openActions.length > 0 && (
                  <span className="note-actions">
                    {openActions
                      .filter((action) => toolbarIcons.includes(action))
                      .map((action) => (
                        <button
                          key={action}
                          className="icon-button wide-only"
                          aria-label={
                            toolbarLabels[action] ?? actionLabels[action]
                          }
                          title={toolbarLabels[action] ?? actionLabels[action]}
                          onClick={() =>
                            void runAction(action, openTarget!, "open")
                          }
                        >
                          <Icon name={actionIcons[action]} size={18} />
                        </button>
                      ))}
                    <button
                      className="icon-button more"
                      aria-label="More actions"
                      title="More actions"
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        openMenu(
                          openTarget!,
                          "open",
                          { x: box.right - 230, y: box.bottom + 4 },
                          // Wide screens show the main actions as buttons.
                          phone
                            ? undefined
                            : (action) => !toolbarIcons.includes(action),
                        );
                      }}
                    >
                      <Icon name="more" size={18} />
                    </button>
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
        <section className="settings-region" hidden={view !== "settings"}>
          <header className="settings-pane-header">
            {shownTab === null ? (
              <button className="back-button" onClick={leaveSettings}>
                <Icon name="back" size={18} />
                Notes
              </button>
            ) : (
              <button className="back-button" onClick={settingsHome}>
                <Icon name="back" size={18} />
                Settings
              </button>
            )}
            <h2>{shownTab ? settingsLabel(shownTab) : "Settings"}</h2>
          </header>
          {view === "settings" && (
            <div className="settings-pane-body">
              {shownTab === null ? (
                <SettingsList onOpen={(tab) => openSettings(tab)} />
              ) : shownTab === "appearance" ? (
                <Appearance />
              ) : shownTab === "about" ? (
                <About />
              ) : (
                <>
                  {live && liveReady ? (
                    <PanelBoundary
                      key={shownTab}
                      onSignedOut={() => session.retry()}
                    >
                      <Suspense fallback={<p>Loading…</p>}>
                        <Panels
                          live={live}
                          panel={shownTab}
                          notebooks={notebooks}
                        />
                      </Suspense>
                    </PanelBoundary>
                  ) : (
                    <p className="muted">
                      {shownTab === "account"
                        ? "Connect to the server to change your name, default notebook and Trash settings."
                        : "Connect to the server to manage this."}
                    </p>
                  )}
                  {shownTab === "account" && (
                    <SessionControls
                      status={sessionStatus}
                      detail={snapshot.error ?? null}
                      canSignOut={permitted}
                      onRetry={() => session.retry()}
                      onSignOut={() => session.logout()}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </main>
      {dialog && live && liveReady && (
        <PanelBoundary onSignedOut={() => session.retry()}>
          <Suspense fallback={null}>
            <Panels
              live={live}
              panel={dialog.kind}
              notebooks={notebooks}
              noteId={dialog.kind === "notebook" ? undefined : dialog.noteId}
              notebookId={
                dialog.kind === "notebook" || dialog.kind === "move"
                  ? (dialog.notebookId ?? undefined)
                  : undefined
              }
              text={dialog.kind === "info" ? dialog.text : undefined}
              onClose={() => setDialog(null)}
              onNotebookCreated={(id) => {
                setDialog(null);
                choose({ kind: "notebook", id });
              }}
            />
          </Suspense>
        </PanelBoundary>
      )}
      {menu && !menuStale && (
        <ActionMenu
          title={menu.target.title}
          actions={menu.actions}
          anchor={menu.anchor}
          sheet={phone || menu.anchor === null}
          onPick={(action) => void runAction(action, menu.target, menu.source)}
          onClose={() => setMenu(null)}
        />
      )}
      <ToastHost toasts={toasts} dismiss={dismissToast} />
      <dialog
        ref={navSheet}
        className="mobile-nav-sheet"
        aria-label="Navigation"
        onTouchStart={(event) => {
          // A swipe down closes the sheet when its list is at the top.
          sheetGesture.current =
            event.currentTarget.scrollTop <= 0
              ? (event.touches[0]?.clientY ?? null)
              : null;
        }}
        onTouchEnd={(event) => {
          const start = sheetGesture.current;
          const end = event.changedTouches[0]?.clientY;
          sheetGesture.current = null;
          if (start !== null && end !== undefined && end - start > SHEET_SWIPE)
            navSheet.current?.close();
        }}
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
