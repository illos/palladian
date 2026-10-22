import { describe, expect, test } from "vitest";
import {
  newNoteNotebook,
  notebookActions,
  notebookCounts,
  previewMatches,
  type NotebookTarget,
} from "../../src/notebook-actions";

const notebook = (over: Partial<NotebookTarget> = {}): NotebookTarget => ({
  id: "b1",
  name: "Journal",
  role: "owner",
  isDefault: false,
  ...over,
});

describe("notebook actions", () => {
  test("an owner gets every action, Delete last", () => {
    expect(notebookActions(notebook(), true)).toEqual([
      "new",
      "rename",
      "sharing",
      "default",
      "delete",
    ]);
  });

  test("the default notebook is not offered as default again, but can be deleted", () => {
    // Its dialog asks for another default first, as the server requires.
    expect(notebookActions(notebook({ isDefault: true }), true)).toEqual([
      "new",
      "rename",
      "sharing",
      "delete",
    ]);
  });

  test("members never get owner actions", () => {
    expect(notebookActions(notebook({ role: "edit" }), true)).toEqual([
      "new",
      "members",
    ]);
    expect(notebookActions(notebook({ role: "read" }), true)).toEqual([
      "members",
    ]);
    for (const role of ["edit", "read"] as const)
      for (const id of ["rename", "sharing", "default", "delete"] as const)
        expect(notebookActions(notebook({ role }), true)).not.toContain(id);
  });

  test("offline, only a new note (a draft on this device) remains", () => {
    expect(notebookActions(notebook(), false)).toEqual(["new"]);
    expect(notebookActions(notebook({ role: "edit" }), false)).toEqual(["new"]);
    expect(notebookActions(notebook({ role: "read" }), false)).toEqual([]);
  });
});

describe("notebook counts", () => {
  test("count cached notes per notebook, leaving out Trash", () => {
    const counts = notebookCounts([
      { notebookId: "a" },
      { notebookId: "a" },
      { notebookId: "a", trashed: true },
      { notebookId: "b", trashed: false },
      { notebookId: undefined },
      {},
    ]);
    expect([...counts]).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    expect(counts.get("c")).toBeUndefined();
  });
});

describe("review round 1", () => {
  const listed = [
    { id: "mine", role: "owner" as const },
    { id: "team", role: "edit" as const },
    { id: "recipes", role: "read" as const },
  ];

  test("F1: a new note goes only to a listed notebook that takes the person's notes", () => {
    expect(newNoteNotebook("mine", listed)).toBe("mine");
    expect(newNoteNotebook("team", listed)).toBe("team");
    // Read-only, gone from this device (deleted or unshared elsewhere), or
    // All Notes: none, so the default notebook takes it.
    expect(newNoteNotebook("recipes", listed)).toBeUndefined();
    expect(newNoteNotebook("deleted", listed)).toBeUndefined();
    expect(newNoteNotebook(null, listed)).toBeUndefined();
  });

  test("F5: deleting waits for the preview of the destination and choice now selected", () => {
    const preview = { destinationId: "archive", trash: false };
    expect(previewMatches(undefined, "archive", false)).toBe(false);
    expect(previewMatches(null, "archive", false)).toBe(false);
    expect(previewMatches(preview, "archive", false)).toBe(true);
    expect(previewMatches(preview, "notes", false)).toBe(false);
    expect(previewMatches(preview, "archive", true)).toBe(false);
  });
});
