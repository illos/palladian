import { describe, expect, test } from "vitest";
import {
  notebookActions,
  notebookCounts,
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
