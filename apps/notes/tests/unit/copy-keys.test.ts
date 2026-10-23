import { describe, expect, test } from "vitest";
import { CopyKeys } from "../../src/copy-keys";

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
