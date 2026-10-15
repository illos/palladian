import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore } from "../../src/cache";
import { draftOf, pauseRecovery } from "./fake-server";

type Db = {
  drafts: {
    put: (...args: unknown[]) => Promise<unknown>;
    count(): Promise<number>;
  };
  accounts: { put: (...args: unknown[]) => Promise<unknown> };
};
const dbOf = (store: NotesStore) => (store as unknown as { db: Db }).db;
/** Make writes to `table` fail as if storage were full, until restored. */
function fill(store: NotesStore, table: "drafts" | "accounts") {
  const target = dbOf(store)[table];
  const put = target.put;
  target.put = async () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  return () => {
    target.put = put;
  };
}
interface Private {
  retireSnapshots(accountId: string): void;
  saveRetired(accountId: string): Promise<void>;
}
const activate = async (store: NotesStore) =>
  store.allowAccount(
    "account",
    await store.captureActivationFence(),
    () => true,
  );
/** Unsaved typing this store could keep only in memory. */
async function unsaved(store: NotesStore, text: string, id = "local-a") {
  const restore = fill(store, "drafts");
  await expect(
    store.writeDraft(draftOf(markdownToDoc(text), { id })),
  ).rejects.toThrow("quota");
  restore();
}

describe("other tabs follow a retirement, never a clear", () => {
  test("the receiving tab is told the account was retired", async () => {
    const name = "r10-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      const events = new Promise<{ retired?: boolean }>((resolve) =>
        other.subscribe((event) => {
          if (event.invalidated) resolve(event);
        }),
      );
      await store.retireAccount("account");
      expect((await events).retired).toBe(true);
    } finally {
      store.close();
      other.close();
    }
  });
});

describe("retired work is kept until it is saved", () => {
  test("a failed retirement keeps the only copy of unsaved typing", async () => {
    const store = new NotesStore("r10-" + crypto.randomUUID());
    try {
      await unsaved(store, "Only copy");
      const restore = fill(store, "accounts");
      await expect(store.retireAccount("account")).rejects.toThrow();
      restore();
      await activate(store);
      expect(
        (await store.exportDrafts("account")).map((draft) => draft.text),
      ).toEqual(["Only copy"]);
    } finally {
      store.close();
    }
  });

  test("typing that still cannot be saved returns with the account", async () => {
    const store = new NotesStore("r10-" + crypto.randomUUID());
    try {
      await unsaved(store, "Still unsaved");
      const restore = fill(store, "drafts");
      await store.retireAccount("account");
      await activate(store);
      // Storage is still full: the typing is this tab's unsaved snapshot again.
      expect(
        (await store.exportDrafts("account")).map((draft) => draft.text),
      ).toEqual(["Still unsaved"]);
      restore();
    } finally {
      store.close();
    }
  });

  test("a different stored draft of the same time is kept beside the typing", async () => {
    const name = "r10-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      await unsaved(store, "Typed here");
      await other.writeDraft(
        draftOf(markdownToDoc("Typed there"), { id: "local-a" }),
      );
      await store.retireAccount("account");
      await activate(store);
      expect(
        (await store.exportDrafts("account")).map((draft) => draft.text).sort(),
      ).toEqual(["Typed here", "Typed there"]);
    } finally {
      store.close();
      other.close();
    }
  });
});

describe("a cleared account is never restored by a late save", () => {
  test("a retirement save after the account was cleared writes nothing", async () => {
    const name = "r10-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      // Another tab holds unsaved typing; its retirement save is delayed.
      await unsaved(other, "Late typing");
      const target = other as unknown as Private;
      const save = target.saveRetired.bind(other);
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      let saving: Promise<void> | undefined;
      const started = new Promise<void>((resolve) => {
        target.saveRetired = (accountId) => {
          saving = gate.then(() => save(accountId));
          resolve();
          return saving;
        };
      });
      await store.retireAccount("account");
      await started;
      // The account is cleared (signed out or revoked) before that save runs.
      await store.clearAccount("account");
      resume();
      await saving;
      expect(await dbOf(store).drafts.count()).toBe(0);
    } finally {
      store.close();
      other.close();
    }
  });
});

describe("sign-out settlement is read at one point", () => {
  test("a hold during the read is reflected in both the export and the held count", async () => {
    const name = "r10-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      await store.cacheSummaries(
        "account",
        [
          {
            id: "note",
            title: "Plan",
            preview: "",
            updatedAt: 1,
            notebookId: "gone",
            role: "edit",
            trashed: false,
          },
        ],
        [],
        await store.captureFence("account"),
      );
      await store.writeDraft(
        draftOf(markdownToDoc("Work"), { notebookId: "gone" }),
      );
      await pauseRecovery(store, async () =>
        other.reconcileAccess(
          "account",
          new Set(),
          new Set(),
          await other.captureFence("account"),
        ),
      );
      expect(await store.settlement("account")).toEqual({
        drafts: [],
        total: 1,
        held: 1,
      });
    } finally {
      store.close();
      other.close();
    }
  });
});

describe("the library shows the newest version", () => {
  test("a newer stored draft wins over an older unsaved snapshot", async () => {
    const name = "r10-" + crypto.randomUUID();
    const store = new NotesStore(name);
    const other = new NotesStore(name);
    try {
      await unsaved(store, "Older title");
      await other.writeDraft(
        draftOf(markdownToDoc("Newer title"), { id: "local-a", updatedAt: 2 }),
      );
      expect((await store.list("account"))[0]!.title).toBe("Newer title");
    } finally {
      store.close();
      other.close();
    }
  });
});
