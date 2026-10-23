import { describe, expect, test } from "vitest";
import {
  draftNotebookLost,
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

describe("review round 2", () => {
  const listed = [
    { id: "mine", role: "owner" as const },
    { id: "team", role: "edit" as const },
    { id: "recipes", role: "read" as const },
  ];
  const seen = new Map<string, "owner" | "edit" | "read">([
    ["mine", "owner"],
    ["team", "edit"],
    ["old-mine", "owner"],
    ["old-team", "edit"],
  ]);
  const deletedByMe = new Set(["server-says-mine"]);
  const lost = (id: string, notebookId?: string) =>
    draftNotebookLost(
      { id, ...(notebookId ? { notebookId } : {}) },
      listed,
      (notebook) => seen.get(notebook),
      (notebook) => deletedByMe.has(notebook),
    );

  test("R2-1: an uncreated draft is lost when its notebook stops taking the person's notes", () => {
    // Still listed and editable.
    expect(lost("local-1", "mine")).toBe(false);
    expect(lost("local-1", "team")).toBe(false);
    // Read-only now.
    expect(lost("local-1", "recipes")).toBe(true);
    // Gone from the list: someone else's notebook, or one never seen here.
    expect(lost("local-1", "old-team")).toBe(true);
    expect(lost("local-1", "never-seen")).toBe(true);
    // The person's own deleted notebook: the server files the draft in
    // their default notebook, so it stays.
    expect(lost("local-1", "old-mine")).toBe(false);
    // No notebook (the default), and notes already on the server.
    expect(lost("local-1")).toBe(false);
    expect(lost("server-note", "old-team")).toBe(false);
  });
});

describe("review round 3", () => {
  const listed = [{ id: "team", role: "edit" as const }];
  const lost = (
    id: string,
    notebookId: string,
    lastRole?: "owner" | "edit" | "read",
    serverSaysMine = false,
  ) =>
    draftNotebookLost(
      { id, notebookId },
      listed,
      () => lastRole,
      () => serverSaysMine,
    );
  const uuid = "123e4567-e89b-42d3-a456-426614174000";

  test("R3-2: drafts with bare UUIDs from earlier offline creation count as uncreated", () => {
    expect(lost(uuid, "gone")).toBe(true);
    expect(lost(uuid, "team")).toBe(false);
    expect(lost("server-note", "gone")).toBe(false);
  });

  test("R3-4: unknown ownership is not permission; the server's answer or this tab's evidence is", () => {
    // After a reload or in a new tab, nothing is known until the server says.
    expect(lost("local-1", "gone")).toBe(true);
    expect(lost("local-1", "gone", undefined, true)).toBe(false);
    expect(lost("local-1", "gone", "owner")).toBe(false);
    // Someone else's notebook stays lost.
    expect(lost("local-1", "gone", "edit")).toBe(true);
  });
});
