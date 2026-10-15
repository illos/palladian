import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { collab, getVersion } from "prosemirror-collab";
import { EditorState } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { LiveController, tokenSubject } from "../../src/live";

const body = (id: string, text = "synthetic") => ({
  accountId: "account",
  id,
  document: JSON.stringify(markdownToDoc(text).toJSON()),
  text,
  revision: 0,
});

describe("journal reopening", () => {
  test("replaying pending steps on the base document applies them once", () => {
    const base = markdownToDoc("Hello");
    const initial = EditorState.create({
      doc: base,
      plugins: [collab({ version: 0, clientID: "client" })],
    });
    const change = initial.tr.insertText("!", 6);
    const draft = {
      document: JSON.stringify(change.doc.toJSON()),
      baseDocument: JSON.stringify(base.toJSON()),
      steps: change.steps.map((s) => JSON.stringify(s.toJSON())),
    };
    // What App + NoteEditor now do: start from baseDocument, replay steps once.
    let state = EditorState.create({
      doc: base.type.schema.nodeFromJSON(JSON.parse(draft.baseDocument)),
      plugins: [collab({ version: 0, clientID: "client" })],
    });
    const replay = state.tr;
    for (const json of draft.steps)
      replay.step(Step.fromJSON(base.type.schema, JSON.parse(json)));
    state = state.apply(replay);
    expect(state.doc.textContent).toBe("Hello!");
    expect(getVersion(state)).toBe(0);
  });
});

describe("note access fences", () => {
  test("revocation blocks late responses and other tabs' recovery export", async () => {
    const name = "review-" + crypto.randomUUID();
    const a = new NotesStore(name);
    const b = new NotesStore(name);
    try {
      const note = body("note");
      const fence = await a.captureFence("account");
      await a.cacheAccepted(note, 1, fence);
      await a.writeDraft({ ...note, updatedAt: 2, baseRevision: 0 });
      await b.cacheSummaries("account", [], ["note"], fence);
      // Let the BroadcastChannel deliver the revocation to the other store.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await b.read("account", "note")).toBeUndefined();
      expect((await a.exportDrafts("account")).map((d) => d.id)).not.toContain(
        "note",
      );
      await expect(b.cacheAccepted(note, 1, fence)).rejects.toThrow(/removed/);
      await expect(
        a.writeDraft({ ...note, updatedAt: 3, baseRevision: 0 }),
      ).rejects.toThrow(/removed/);
      expect(await b.read("account", "note")).toBeUndefined();
      // A fresh server access check issued after the revocation lifts the fence.
      const markers = await b.revocationMarkers("account", ["note"]);
      await b.allowNotes(
        "account",
        [{ id: "note", marker: markers.get("note")! }],
        fence,
      );
      await b.cacheSummaries(
        "account",
        [
          {
            id: "note",
            title: "t",
            preview: "",
            updatedAt: 1,
            notebookId: "nb",
            role: "read",
            trashed: false,
          },
        ],
        [],
        fence,
      );
      await b.cacheAccepted(note, 1, fence);
      expect(await b.read("account", "note")).toBeDefined();
    } finally {
      a.close();
      b.close();
    }
  });

  test("reconciliation removes notes outside the snapshot but keeps local drafts", async () => {
    const store = new NotesStore("reconcile-" + crypto.randomUUID());
    try {
      const fence = await store.captureFence("account");
      await store.cacheSummaries(
        "account",
        [
          {
            id: "shared",
            title: "s",
            preview: "",
            updatedAt: 1,
            notebookId: "other",
            role: "read",
            trashed: false,
          },
          {
            id: "revoked",
            title: "r",
            preview: "",
            updatedAt: 1,
            notebookId: "other",
            role: "read",
            trashed: false,
          },
          {
            id: "visible",
            title: "v",
            preview: "",
            updatedAt: 1,
            notebookId: "mine",
            role: "owner",
            trashed: false,
          },
        ],
        [],
        fence,
      );
      await store.writeDraft({
        ...body("local-draft"),
        updatedAt: 1,
        notebookId: "gone",
      });
      const { revoked } = await store.reconcileAccess(
        "account",
        new Set(["mine"]),
        new Set(["shared"]),
        fence,
      );
      expect(revoked).toEqual(["revoked"]);
      const ids = (await store.list("account")).map((row) => row.id).sort();
      expect(ids).toEqual(["local-draft", "shared", "visible"]);
    } finally {
      store.close();
    }
  });
});

describe("session-bound backend tokens", () => {
  const jwt = (sub: string) =>
    ["header", btoa(JSON.stringify({ sub })).replace(/=+$/, ""), "sig"].join(
      ".",
    );

  test("reads the token subject", () => {
    expect(tokenSubject(jwt("account-B"))).toBe("account-B");
    expect(tokenSubject("garbage")).toBeNull();
  });

  test("a token for another account is refused and the session rechecked", async () => {
    const instance = Object.create(LiveController.prototype) as LiveController;
    let fetchToken: (args: {
      forceRefreshToken: boolean;
    }) => Promise<string | null> = async () => null;
    let retried = false;
    Object.assign(instance, {
      session: {
        getSnapshot: () => ({
          status: "ready",
          accountId: "account-A",
          generation: 1,
        }),
        retry: () => {
          retried = true;
        },
      },
      auth: {
        convex: { token: async () => ({ data: { token: jwt("account-B") } }) },
      },
      state: { accountId: null, ready: false, profile: null, connected: false },
      listeners: new Set(),
      stops: [],
      feeds: new Map(),
      fetchQueue: new Map(),
      visibleNotebooks: null,
      tokenRequest: 0,
      client: {
        setAuth: (fetcher: typeof fetchToken) => {
          fetchToken = fetcher;
        },
        clearAuth: () => {},
      },
    });
    (instance as unknown as { follow: () => void }).follow();
    expect(await fetchToken({ forceRefreshToken: true })).toBeNull();
    expect(retried).toBe(true);
  });
});
