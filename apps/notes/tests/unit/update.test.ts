import "fake-indexeddb/auto";
import { markdownToDoc, notesSchema } from "@palladian/notes-core";
import { collab } from "prosemirror-collab";
import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, test, vi } from "vitest";
import { NotesStore } from "../../src/cache";
import { NoteChannel } from "../../src/channel";
import { updateApp } from "../../src/update";

/** A waiting worker that activates (or fails to) when told to skip waiting. */
function waitingWorker(outcome: "activated" | "redundant" = "activated") {
  const worker = new EventTarget() as EventTarget & {
    state: string;
    postMessage: (message: unknown) => void;
  };
  worker.state = "installed";
  worker.postMessage = vi.fn(() => {
    setTimeout(() => {
      worker.state = outcome;
      worker.dispatchEvent(new Event("statechange"));
    }, 5);
  });
  const registration = {
    waiting: worker,
    installing: null,
    update: vi.fn(async () => undefined),
  } as unknown as ServiceWorkerRegistration;
  return { worker, registration };
}

describe("Update now", () => {
  test("nothing activates while typing is not stored", async () => {
    const { worker, registration } = waitingWorker();
    const reload = vi.fn();
    const ready = vi.fn(async () => false);
    const outcome = await updateApp({
      getRegistration: async () => registration,
      online: () => true,
      reload,
      ready,
    });
    expect(outcome).toBe("unsaved");
    expect(ready).toHaveBeenCalledWith("activate");
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("a note opened before activation finishes holds the reload", async () => {
    const { worker, registration } = waitingWorker();
    const reload = vi.fn();
    const stages: string[] = [];
    const outcome = await updateApp({
      getRegistration: async () => registration,
      online: () => true,
      reload,
      ready: async (stage) => {
        stages.push(stage);
        return stage === "activate";
      },
    });
    expect(outcome).toBe("installed");
    expect(stages).toEqual(["activate", "reload"]);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();
  });

  test("reloads once the new build is active and typing is stored", async () => {
    const { registration } = waitingWorker();
    const reload = vi.fn();
    expect(
      await updateApp({
        getRegistration: async () => registration,
        online: () => true,
        reload,
        ready: async () => true,
      }),
    ).toBe("updating");
    expect(reload).toHaveBeenCalledOnce();
  });

  test("a build that fails to activate does not reload", async () => {
    const { registration } = waitingWorker("redundant");
    const reload = vi.fn();
    expect(
      await updateApp({
        getRegistration: async () => registration,
        online: () => true,
        reload,
        ready: async () => true,
      }),
    ).toBe("failed");
    expect(reload).not.toHaveBeenCalled();
  });

  test("no waiting build means nothing is checked or closed", async () => {
    const ready = vi.fn(async () => true);
    const registration = {
      waiting: null,
      installing: null,
      update: async () => undefined,
    } as unknown as ServiceWorkerRegistration;
    expect(
      await updateApp({
        getRegistration: async () => registration,
        online: () => true,
        ready,
      }),
    ).toBe("latest");
    expect(ready).not.toHaveBeenCalled();
  });
});

/** An open collaborative note on a real store, with a minimal editor view. */
async function openNote() {
  const store = new NotesStore("update-" + crypto.randomUUID());
  await store.allowAccount(
    "account",
    await store.captureActivationFence(),
    () => true,
  );
  const doc = markdownToDoc("Draft");
  const channel = new NoteChannel({
    store,
    accountId: "account",
    noteId: "note-1",
    created: true,
    baseDocument: JSON.stringify(doc.toJSON()),
    baseRevision: 3,
    clientId: "client",
    pending: [],
    onStatus: () => undefined,
  });
  const view = {
    state: EditorState.create({
      schema: notesSchema,
      doc,
      plugins: [collab({ version: 3, clientID: "client" })],
    }),
  } as { state: EditorState };
  channel.attach(view as unknown as EditorView);
  const type = (text: string) => {
    const tr = view.state.tr.insertText(text, view.state.doc.content.size - 1);
    view.state = view.state.apply(tr);
    channel.changed(view as unknown as EditorView, tr);
  };
  return { store, channel, type };
}

describe("update readiness with an open note", () => {
  test("typing still waiting for the journal is stored when the note closes", async () => {
    const { store, channel, type } = await openNote();
    type(" typed just now");
    // The journal waits briefly after typing, so the store cannot see it yet:
    // elapsed time alone does not make it durable.
    expect(await store.hasUndurableWork("account")).toBe(false);
    expect(await store.readDraft("account", "note-1")).toBeUndefined();
    // Closing the note hands it over at once; readiness then waits for it.
    channel.close();
    expect(await store.hasUndurableWork("account")).toBe(false);
    expect((await store.readDraft("account", "note-1"))?.text).toContain(
      "typed just now",
    );
  });

  test("a journal write that fails keeps the update from reloading", async () => {
    const { store, channel, type } = await openNote();
    const drafts = (
      store as unknown as { db: { drafts: { put: () => Promise<never> } } }
    ).db.drafts;
    drafts.put = async () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    type(" that cannot be stored");
    channel.close();
    expect(await store.hasUndurableWork("account")).toBe(true);
  });
});
