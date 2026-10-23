import { describe, expect, test } from "vitest";
import type { ConvexReactClient } from "convex/react";
import { failInSession, inSession } from "../../src/in-session";
import { duplicateNote } from "../../src/note-tools";

// History review round 6 (R6-1): a copy (Duplicate, Restore as a new note)
// goes out only for the account and session it started in, and its answer
// changes the screen only if that session still holds.

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
function client() {
  const sent: Record<string, unknown>[] = [];
  const fake = {
    mutation: async (_ref: unknown, args: Record<string, unknown>) => {
      sent.push(args);
      return { noteId: "copy-id", revision: 0, replayed: false };
    },
  };
  return { sent, client: fake as unknown as ConvexReactClient };
}

describe("copies within the session they started in", () => {
  test("an unchanged session sends the copy, naming its account, and completes", async () => {
    const ada = device("account-a");
    const { sent, client: convex } = client();
    const made = await inSession(
      ada.ticket(),
      async () => ({ client: convex }),
      ({ client }) =>
        duplicateNote(client, "account-a", "{}", "nb-1", "note-1", "key-1"),
    );
    expect(made).toEqual({ sent: true, result: "copy-id", current: true });
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

  test("an answer after a switch to B is not shown to B", async () => {
    const ada = device("account-a");
    const { client: convex } = client();
    const made = await inSession(
      ada.ticket(),
      async () => ({ client: convex }),
      async ({ client }) => {
        const id = await duplicateNote(
          client,
          "account-a",
          "{}",
          undefined,
          "note-1",
        );
        ada.switchTo("account-b");
        return id;
      },
    );
    // Sent in Ada's session (and naming her account, which the server checks
    // against whoever is signed in when it arrives), but answered under Bea:
    // the caller shows no toast or dialog change.
    expect(made).toEqual({ sent: true, result: "copy-id", current: false });
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

describe("failures within the session they started in", () => {
  /** The server's refusal of a copy that names another account. */
  const refusal = Object.assign(
    new Error("This change was made in another account."),
    { data: { code: "conflict" } },
  );

  /** Duplicate's composition in App: the copy, fenced for failures too. */
  function duplicate(ada: ReturnType<typeof device>, during: () => void) {
    const current = ada.ticket();
    return failInSession(current, () =>
      inSession(
        current,
        async () => ({}),
        async () => {
          during();
          throw refusal;
        },
      ),
    );
  }

  test("a refusal in the same session reaches the screen", async () => {
    const ada = device("account-a");
    await expect(duplicate(ada, () => {})).rejects.toBe(refusal);
  });

  test("a refusal after a switch to B shows B nothing", async () => {
    const ada = device("account-a");
    // Bea signs in while Ada's copy is on its way; the server then refuses it.
    expect(await duplicate(ada, () => ada.switchTo("account-b"))).toBe(
      undefined,
    );
  });

  test("a failure while preparing, after a switch, shows nothing", async () => {
    const ada = device("account-a");
    const current = ada.ticket();
    expect(
      await failInSession(current, async () => {
        ada.switchTo("account-b");
        throw new Error("Could not load the note.");
      }),
    ).toBe(undefined);
  });

  test("a success passes through unchanged", async () => {
    const ada = device("account-a");
    expect(await failInSession(ada.ticket(), async () => "copy-id")).toBe(
      "copy-id",
    );
  });
});
