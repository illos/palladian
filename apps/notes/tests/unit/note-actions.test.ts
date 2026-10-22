import { describe, expect, test } from "vitest";
import {
  isLocalNoteId,
  noteActions,
  swipeLayout,
  type ActionTarget,
} from "../../src/note-actions";

const note = (over: Partial<ActionTarget> = {}): ActionTarget => ({
  id: "n1",
  local: false,
  role: "owner",
  trashed: false,
  ...over,
});

describe("note actions", () => {
  test("an owner's note offers everything, Pin first and Trash last", () => {
    expect(noteActions(note(), true)).toEqual([
      "pin",
      "duplicate",
      "move",
      "share",
      "info",
      "export",
      "print",
      "trash",
    ]);
  });

  test("an editor cannot move; a reader cannot move or trash", () => {
    expect(noteActions(note({ role: "edit" }), true)).not.toContain("move");
    expect(noteActions(note({ role: "edit" }), true)).toContain("trash");
    const read = noteActions(note({ role: "read" }), true);
    expect(read).not.toContain("move");
    expect(read).not.toContain("trash");
    expect(read).toContain("duplicate");
    // Pins are personal, so readers pin too.
    expect(read).toContain("pin");
    expect(noteActions(note({ pinned: true }), true)[0]).toBe("unpin");
  });

  test("in Trash: restore for editors, delete forever for the owner only", () => {
    expect(noteActions(note({ trashed: true }), true)).toEqual([
      "restore",
      "info",
      "export",
      "print",
      "delete",
    ]);
    expect(noteActions(note({ trashed: true, role: "edit" }), true)).toEqual([
      "restore",
      "info",
      "export",
      "print",
    ]);
  });

  test("offline, only export and print remain", () => {
    expect(noteActions(note(), false)).toEqual(["export", "print"]);
    expect(noteActions(note({ trashed: true }), false)).toEqual([
      "export",
      "print",
    ]);
  });

  test("local drafts offer nothing", () => {
    expect(noteActions(note({ local: true }), true)).toEqual([]);
  });

  test("swipes follow the same rules", () => {
    expect(swipeLayout(note(), true)).toEqual({
      leading: ["duplicate"],
      trailing: ["move", "share"],
      full: "trash",
      fullLeading: "pin",
    });
    expect(swipeLayout(note({ role: "read", pinned: true }), true)).toEqual({
      leading: ["duplicate"],
      trailing: ["share"],
      full: null,
      fullLeading: "unpin",
    });
    expect(swipeLayout(note({ trashed: true }), true)).toEqual({
      leading: ["restore"],
      trailing: ["delete"],
      full: null,
      fullLeading: null,
    });
    expect(swipeLayout(note(), false)).toEqual({
      leading: [],
      trailing: [],
      full: null,
      fullLeading: null,
    });
  });
});

describe("local notes", () => {
  test("only notes not yet on the server count as local", () => {
    expect(isLocalNoteId("local-0123abcd")).toBe(true);
    expect(isLocalNoteId("0b6c7a52-1f0e-4b8e-9b55-3a3a6f1c2d4e")).toBe(true);
    // A server note keeps its ID while it has unsent edits.
    expect(isLocalNoteId("k57c9x1p2h3m4n5q6r7s8t9v0w1y2z3")).toBe(false);
  });
});
