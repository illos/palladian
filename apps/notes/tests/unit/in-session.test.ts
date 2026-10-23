import { describe, expect, test } from "vitest";
import type { ConvexReactClient } from "convex/react";
import {
  copyInSession,
  inSession,
  serverAnswered,
  type CopyScreen,
} from "../../src/in-session";
import { duplicateNote } from "../../src/note-tools";

// History review rounds 6 and 7: a copy (Duplicate, Restore as a new note)
// goes out only for the account and session it started in (R6-1), and every
// change it makes to the screen afterwards, including a failure and the
// toast's Open, happens only while that session holds (R7-1, R7-2).

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

/** A client that records the mutations it is asked to send. */
function client(answer: () => Promise<unknown> = async () => undefined) {
  const sent: Record<string, unknown>[] = [];
  const fake = {
    mutation: async (_ref: unknown, args: Record<string, unknown>) => {
      sent.push(args);
      await answer();
      return { noteId: "copy-id", revision: 0, replayed: false };
    },
  };
  return { sent, client: fake as unknown as ConvexReactClient };
}

/** The server's refusal of a copy that names another account. */
const refusal = Object.assign(
  new Error("This change was made in another account."),
  { data: { code: "conflict" } },
);

/**
 * App's screen for a copy, recording which account was signed in at each
 * change: the toast with Open, a failure, and an opened note.
 */
function screen(ada: ReturnType<typeof device>) {
  const shown: { what: string; account: string }[] = [];
  let open: (() => void) | null = null;
  const ui: CopyScreen<string> = {
    made: (id, openCopy) => {
      shown.push({ what: `made ${id}`, account: ada.now.account });
      open = openCopy;
    },
    failed: (failure) =>
      shown.push({
        what: `failed ${(failure as Error).message}`,
        account: ada.now.account,
      }),
  };
  const opened = (id: string) =>
    shown.push({ what: `opened ${id}`, account: ada.now.account });
  return { shown, ui, opened, pressOpen: () => open?.() };
}

/** Switches the device to B after `ticks` microtasks. */
function switchAfter(ada: ReturnType<typeof device>, ticks: number) {
  let chain = Promise.resolve();
  for (let tick = 0; tick < ticks; tick++) chain = chain.then(() => {});
  void chain.then(() => ada.switchTo("account-b"));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("copies within the session they started in", () => {
  test("an unchanged session sends the copy, naming its account", async () => {
    const ada = device("account-a");
    const { sent, client: convex } = client();
    const made = await inSession(
      ada.ticket(),
      async () => ({ client: convex }),
      ({ client }) =>
        duplicateNote(client, "account-a", "{}", "nb-1", "note-1", "key-1"),
    );
    expect(made).toEqual({ sent: true, result: "copy-id" });
    expect(sent).toEqual([
      {
        clientKey: "key-1",
        doc: "{}",
        notebookId: "nb-1",
        sourceNoteId: "note-1",
        account: "account-a",
      },
    ]);
  });

  test("switching A → B while the copy is prepared sends nothing", async () => {
    const ada = device("account-a");
    const { sent, client: convex } = client();
    const made = await inSession(
      ada.ticket(),
      async () => {
        // The await for the copy helper, during which Bea signs in.
        ada.switchTo("account-b");
        return { client: convex };
      },
      ({ client }) =>
        duplicateNote(client, "account-a", "{}", undefined, "note-1"),
    );
    expect(made).toEqual({ sent: false });
    expect(sent).toEqual([]);
  });

  test("a session that has already changed prepares nothing", async () => {
    const ada = device("account-a");
    const ticket = ada.ticket();
    ada.switchTo("account-b");
    let prepared = false;
    const made = await inSession(
      ticket,
      async () => {
        prepared = true;
        return {};
      },
      async () => "never",
    );
    expect(made).toEqual({ sent: false });
    expect(prepared).toBe(false);
  });

  test("nothing to send sends nothing", async () => {
    const ada = device("account-a");
    let dispatched = false;
    expect(
      await inSession(
        ada.ticket(),
        async () => null,
        async () => {
          dispatched = true;
          return "never";
        },
      ),
    ).toEqual({ sent: false });
    expect(dispatched).toBe(false);
  });
});

describe("a copy's outcome shows only in its session", () => {
  /** Duplicate's shape in App: read the note, load the helper, send. */
  function duplicate(
    ada: ReturnType<typeof device>,
    ui: ReturnType<typeof screen>,
    answer?: () => Promise<unknown>,
  ) {
    const { client: convex } = client(answer);
    return copyInSession(
      ada.ticket(),
      async () => {
        const doc = await Promise.resolve("{}");
        const helper = await Promise.resolve(duplicateNote);
        return { doc, helper };
      },
      ({ doc, helper }) =>
        helper(convex, "account-a", doc, undefined, "note-1", "key-1"),
      ui.opened,
      ui.ui,
    );
  }

  test("in the same session: the toast shows, and Open opens the copy", async () => {
    const ada = device("account-a");
    const ui = screen(ada);
    expect(await duplicate(ada, ui)).toEqual({ sent: true, result: "copy-id" });
    ui.pressOpen();
    expect(ui.shown).toEqual([
      { what: "made copy-id", account: "account-a" },
      { what: "opened copy-id", account: "account-a" },
    ]);
  });

  test("R7-1: whenever A → B happens, nothing shows under B", async () => {
    let madeInA = 0;
    for (let ticks = 0; ticks <= 40; ticks++) {
      const ada = device("account-a");
      const ui = screen(ada);
      switchAfter(ada, ticks);
      await duplicate(ada, ui);
      await settle();
      expect(ada.now.account).toBe("account-b");
      // Each change happened while A was signed in, never after the switch.
      for (const change of ui.shown) expect(change.account).toBe("account-a");
      if (ui.shown.length) madeInA += 1;
    }
    // The late switches came after the copy's toast: the sweep covers both.
    expect(madeInA).toBeGreaterThan(0);
    expect(madeInA).toBeLessThan(41);
  });

  test("R7-1: whenever A → B happens, a refusal shows nothing under B", async () => {
    let failedInA = 0;
    for (let ticks = 0; ticks <= 40; ticks++) {
      const ada = device("account-a");
      const ui = screen(ada);
      switchAfter(ada, ticks);
      const outcome = await duplicate(ada, ui, async () => {
        throw refusal;
      });
      await settle();
      for (const change of ui.shown) expect(change.account).toBe("account-a");
      if (ui.shown.length) {
        failedInA += 1;
        expect(outcome).toEqual({ failure: refusal });
      }
    }
    expect(failedInA).toBeGreaterThan(0);
    expect(failedInA).toBeLessThan(41);
  });

  test("a refusal in the same session is shown, and nothing is thrown", async () => {
    const ada = device("account-a");
    const ui = screen(ada);
    const outcome = await duplicate(ada, ui, async () => {
      throw refusal;
    });
    expect(outcome).toEqual({ failure: refusal });
    expect(ui.shown).toEqual([
      {
        what: "failed This change was made in another account.",
        account: "account-a",
      },
    ]);
  });

  test("a failure while preparing, after a switch, shows nothing", async () => {
    const ada = device("account-a");
    const ui = screen(ada);
    const outcome = await copyInSession(
      ada.ticket(),
      async () => {
        ada.switchTo("account-b");
        throw new Error("This note's text is not on this device yet.");
      },
      async () => "never",
      ui.opened,
      ui.ui,
    );
    expect("failure" in outcome).toBe(true);
    expect(ui.shown).toEqual([]);
  });

  test("R7-2: Open pressed after A → B opens nothing", async () => {
    const ada = device("account-a");
    const ui = screen(ada);
    await duplicate(ada, ui);
    // The toast stays up; Bea signs in, then the Open button is pressed.
    ada.switchTo("account-b");
    ui.pressOpen();
    expect(ui.shown).toEqual([{ what: "made copy-id", account: "account-a" }]);
  });

  test("R7-2: Open after A signs out and back in opens nothing", async () => {
    const ada = device("account-a");
    const ui = screen(ada);
    await duplicate(ada, ui);
    // Another session of the same account is not the session the copy began in.
    ada.switchTo("account-a");
    ui.pressOpen();
    expect(ui.shown).toEqual([{ what: "made copy-id", account: "account-a" }]);
  });
});

describe("whether the server answered a copy", () => {
  test("made, or refused with a code: answered", () => {
    expect(serverAnswered({ sent: true, result: "copy-id" })).toBe(true);
    expect(serverAnswered({ failure: refusal })).toBe(true);
  });

  test("not sent, or a failure without a code: no answer", () => {
    expect(serverAnswered({ sent: false })).toBe(false);
    expect(serverAnswered({ failure: new Error("Connection lost") })).toBe(
      false,
    );
    expect(serverAnswered({ failure: null })).toBe(false);
    expect(serverAnswered({ failure: "offline" })).toBe(false);
  });
});
