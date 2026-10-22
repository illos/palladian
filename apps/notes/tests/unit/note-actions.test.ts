import { describe, expect, test } from "vitest";
import {
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
  test("an owner's note offers everything, Trash last", () => {
    expect(noteActions(note(), true)).toEqual([
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
    });
    expect(swipeLayout(note({ role: "read" }), true)).toEqual({
      leading: ["duplicate"],
      trailing: ["share"],
      full: null,
    });
    expect(swipeLayout(note({ trashed: true }), true)).toEqual({
      leading: ["restore"],
      trailing: ["delete"],
      full: null,
    });
    expect(swipeLayout(note(), false)).toEqual({
      leading: [],
      trailing: [],
      full: null,
    });
  });
});
