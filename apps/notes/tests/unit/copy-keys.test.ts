import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { CopyKeys, restoreCopy } from "../../src/copy-keys";
import { transportError } from "../../src/live";
import {
  COPY_NEEDS_FILES_MESSAGE,
  copyFailureMessage,
} from "../../src/versions";

// History review round 6 (R6-2): one creation key per Restore-as-new-note
// operation until the server answers, across closing History and retrying.

function keys() {
  let made = 0;
  return new CopyKeys(() => `key-${++made}`);
}

describe("one key per copy operation", () => {
  test("a retry after no answer sends the same key", () => {
    const copies = keys();
    expect(copies.start("a", "note-1", 3)).toBe("key-1");
    expect(copies.state("a", "note-1", 3)).toBe("sending");
    copies.unanswered("a", "note-1", 3);
    // History closed and reopened on the version: still pending.
    expect(copies.state("a", "note-1", 3)).toBe("unconfirmed");
    expect(copies.start("a", "note-1", 3)).toBe("key-1");
  });

  test("a copy already on its way is not sent twice", () => {
    const copies = keys();
    expect(copies.start("a", "note-1", 3)).toBe("key-1");
    expect(copies.start("a", "note-1", 3)).toBeNull();
  });

  test("after an answer, a deliberate second restore makes a new copy", () => {
    const copies = keys();
    expect(copies.start("a", "note-1", 3)).toBe("key-1");
    copies.answered("a", "note-1", 3);
    expect(copies.state("a", "note-1", 3)).toBeNull();
    expect(copies.start("a", "note-1", 3)).toBe("key-2");
  });

  test("operations are separate per account, note and version", () => {
    const copies = keys();
    expect(copies.start("a", "note-1", 3)).toBe("key-1");
    copies.unanswered("a", "note-1", 3);
    expect(copies.state("b", "note-1", 3)).toBeNull();
    expect(copies.state("a", "note-2", 3)).toBeNull();
    expect(copies.state("a", "note-1", 4)).toBeNull();
    expect(copies.start("b", "note-1", 3)).toBe("key-2");
    expect(copies.start("a", "note-1", 4)).toBe("key-3");
    expect(copies.start("a", "note-1", 3)).toBe("key-1");
  });
});

describe("a failed restore's notice", () => {
  test("goes to a panel showing that version, until dismissed or retried", () => {
    const copies = keys();
    const toasts: string[] = [];
    copies.start("a", "note-1", 3);
    const hide = copies.show("a", "note-1", 3);
    copies.failed("a", "note-1", 3, "Refused.", (m) => toasts.push(m));
    copies.answered("a", "note-1", 3);
    expect(copies.notice("a", "note-1", 3)).toBe("Refused.");
    expect(toasts).toEqual([]);
    copies.dismiss("a", "note-1", 3);
    expect(copies.notice("a", "note-1", 3)).toBeNull();
    copies.failed("a", "note-1", 3, "Refused again.", (m) => toasts.push(m));
    expect(copies.start("a", "note-1", 3)).toBe("key-2");
    expect(copies.notice("a", "note-1", 3)).toBeNull();
    hide();
  });

  test("with no panel showing that version, goes to the toast instead", () => {
    const copies = keys();
    const toasts: string[] = [];
    copies.start("a", "note-1", 3);
    // Shown, then History closed; a panel on another version or account.
    copies.show("a", "note-1", 3)();
    copies.show("a", "note-1", 4);
    copies.show("b", "note-1", 3);
    copies.failed("a", "note-1", 3, "Refused.", (m) => toasts.push(m));
    expect(toasts).toEqual(["Refused."]);
    expect(copies.notice("a", "note-1", 3)).toBeNull();
  });

  test("a panel's second hide does not hide another panel's showing", () => {
    const copies = keys();
    const toasts: string[] = [];
    const first = copies.show("a", "note-1", 3);
    copies.show("a", "note-1", 3);
    first();
    first();
    copies.failed("a", "note-1", 3, "Refused.", (m) => toasts.push(m));
    expect(toasts).toEqual([]);
    expect(copies.notice("a", "note-1", 3)).toBe("Refused.");
  });
});

// Review round 8 (R8-1): Restore, close History, reopen the version while the
// copy is on its way, then the server refuses it. The failure is kept with the
// operation in App, not in the panel that started it.

/** A device whose sign-in can switch, with App's session ticket. */
function device(account: string) {
  const now = { account, generation: 1 };
  return {
    now,
    switchTo(next: string) {
      now.account = next;
      now.generation += 1;
    },
    ticket() {
      const at = { ...now };
      return () =>
        now.account === at.account && now.generation === at.generation;
    },
  };
}

/** The server's files-off refusal of a copy (B1). */
const refusal = new ConvexError({
  code: "invalid",
  message: "File blocks are not enabled on this server yet.",
});

/** One restore as App runs it, answered when the test says. */
function restore(
  copies: CopyKeys,
  ada: ReturnType<typeof device>,
  toasts: { message: string; account: string }[],
) {
  let answer: { resolve: (id: string) => void; reject: (e: unknown) => void } =
    { resolve: () => {}, reject: () => {} };
  const sent = new Promise<string>((resolve, reject) => {
    answer = { resolve, reject };
  });
  let markSent = () => {};
  const dispatched = new Promise<void>((resolve) => (markSent = resolve));
  const done = restoreCopy({
    keys: copies,
    account: "account-a",
    noteId: "note-1",
    revision: 3,
    current: ada.ticket(),
    connected: true,
    prepare: async () => ({}),
    dispatch: () => {
      markSent();
      return sent;
    },
    open: () => {},
    made: () => {},
    // The History panel's wording, files off included.
    describe: (failure) => copyFailureMessage(transportError(failure)),
    toast: (message) => toasts.push({ message, account: ada.now.account }),
    changed: () => {},
  });
  return { done, dispatched, answer: () => answer };
}

describe("a restore's failure outlives the panel that started it", () => {
  test("start, close History, reopen the version, refused: the reopened panel shows why", async () => {
    const copies = new CopyKeys();
    const ada = device("account-a");
    const toasts: { message: string; account: string }[] = [];
    const first = copies.show("account-a", "note-1", 3);
    const copy = restore(copies, ada, toasts);
    await copy.dispatched;
    first(); // History closed while the copy is on its way.
    const reopened = copies.show("account-a", "note-1", 3);
    expect(copies.state("account-a", "note-1", 3)).toBe("sending");
    copy.answer().reject(refusal);
    await copy.done;
    // The reopened panel leaves "Creating…" with the reason, not silently.
    expect(copies.state("account-a", "note-1", 3)).toBeNull();
    expect(copies.notice("account-a", "note-1", 3)).toBe(
      COPY_NEEDS_FILES_MESSAGE,
    );
    expect(toasts).toEqual([]);
    reopened();
  });

  test("start, close History, refused with no panel: a toast in the same session", async () => {
    const copies = new CopyKeys();
    const ada = device("account-a");
    const toasts: { message: string; account: string }[] = [];
    const panel = copies.show("account-a", "note-1", 3);
    const copy = restore(copies, ada, toasts);
    await copy.dispatched;
    panel();
    copy.answer().reject(refusal);
    await copy.done;
    expect(toasts).toEqual([
      { message: COPY_NEEDS_FILES_MESSAGE, account: "account-a" },
    ]);
    expect(copies.notice("account-a", "note-1", 3)).toBeNull();
  });

  test("start, close History, A → B, refused: no toast for B", async () => {
    const copies = new CopyKeys();
    const ada = device("account-a");
    const toasts: { message: string; account: string }[] = [];
    const panel = copies.show("account-a", "note-1", 3);
    const copy = restore(copies, ada, toasts);
    await copy.dispatched;
    panel();
    ada.switchTo("account-b");
    copy.answer().reject(refusal);
    await copy.done;
    expect(toasts).toEqual([]);
    expect(copies.notice("account-a", "note-1", 3)).toBeNull();
    // Refused is an answer: A's next restore may use a new key.
    expect(copies.state("account-a", "note-1", 3)).toBeNull();
  });

  test("a copy made after History was reopened needs no notice", async () => {
    const copies = new CopyKeys();
    const ada = device("account-a");
    const toasts: { message: string; account: string }[] = [];
    copies.show("account-a", "note-1", 3)();
    copies.show("account-a", "note-1", 3);
    const copy = restore(copies, ada, toasts);
    copy.answer().resolve("copy-id");
    await copy.done;
    expect(copies.notice("account-a", "note-1", 3)).toBeNull();
    expect(copies.state("account-a", "note-1", 3)).toBeNull();
    expect(toasts).toEqual([]);
  });
});

// Review round 9 (R9-1): a restore invoked after its session ended (A's
// callback, run once B has signed in) shows nothing and sends nothing; only
// the current session is told it is offline.
describe("a restore that starts outside its session", () => {
  function startRestore(
    copies: CopyKeys,
    current: () => boolean,
    connected: boolean,
    toasts: string[],
  ) {
    let sent = 0;
    const done = restoreCopy({
      keys: copies,
      account: "account-a",
      noteId: "note-1",
      revision: 3,
      current,
      connected,
      prepare: async () => ({}),
      dispatch: async () => {
        sent += 1;
        return "copy-id";
      },
      open: () => {},
      made: () => {},
      describe: (failure) => copyFailureMessage(transportError(failure)),
      toast: (message) => toasts.push(message),
      changed: () => {},
    });
    return { done, sent: () => sent };
  }

  test("after A → B, A's restore shows B nothing and sends nothing", async () => {
    const copies = new CopyKeys();
    const ada = device("account-a");
    const current = ada.ticket();
    ada.switchTo("account-b");
    const toasts: string[] = [];
    for (const connected of [true, false]) {
      const copy = startRestore(copies, current, connected, toasts);
      await copy.done;
      expect(copy.sent()).toBe(0);
    }
    expect(toasts).toEqual([]);
    expect(copies.notice("account-a", "note-1", 3)).toBeNull();
    expect(copies.state("account-a", "note-1", 3)).toBeNull();
  });

  test("offline in the same session still says so", async () => {
    const copies = new CopyKeys();
    const ada = device("account-a");
    const toasts: string[] = [];
    const copy = startRestore(copies, ada.ticket(), false, toasts);
    await copy.done;
    expect(copy.sent()).toBe(0);
    expect(toasts).toHaveLength(1);
  });
});
