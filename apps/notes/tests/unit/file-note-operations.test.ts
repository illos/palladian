import { afterEach, describe, expect, test, vi } from "vitest";
import {
  FileNoteOperations,
  type FileNoteOperation,
} from "../../src/file-note-operations";

const scope = { accountId: "ada", generation: 1 };
const note = (title: string) => ({
  title,
  document: JSON.stringify({ type: "doc", content: [] }),
  notebookId: undefined,
});
const file = (name: string, bytes = "x") =>
  new File([bytes], name, { type: "application/zip" });

function operations() {
  const lost: FileNoteOperation[] = [];
  let keys = 0;
  const all = new FileNoteOperations({
    lost: (operation) => lost.push(operation),
    waitMs: 1_000,
    newKey: () => "key-" + ++keys,
  });
  return { all, lost };
}

afterEach(() => vi.useRealTimers());

describe("file notes from the list (review round 1, F3 and F4)", () => {
  test("F3: one key per operation until the server answers; the same file is the retry", () => {
    const { all } = operations();
    const first = all.begin(scope, file("a.zip"), note("a.zip"));
    expect("send" in first && first.send.key).toBe("key-1");
    // On its way: the same file again sends nothing.
    expect("duplicate" in all.begin(scope, file("a.zip"), note("a.zip"))).toBe(
      true,
    );
    // No answer: the same file again, or Retry, sends the same key.
    const id = all.list("ada", 1)[0]!.id;
    all.unanswered(id, "No answer.");
    expect(all.list("ada", 1)[0]).toMatchObject({
      state: "unanswered",
      message: "No answer.",
    });
    const again = all.begin(scope, file("a.zip"), note("a.zip"));
    expect("send" in again && again.send.key).toBe("key-1");
    all.unanswered(id, "No answer.");
    expect(all.retry(id)?.key).toBe("key-1");
    // Another file is another operation, with its own key.
    const other = all.begin(scope, file("b.zip"), note("b.zip"));
    expect("send" in other && other.send.key).toBe("key-2");
  });

  test("F4: each made note's file waits for that note's editor only", () => {
    const { all } = operations();
    const a = all.begin(scope, file("a.zip", "A"), note("a.zip"));
    const b = all.begin(scope, file("b.zip", "B"), note("b.zip"));
    if (!("send" in a) || !("send" in b)) throw new Error("not sent");
    expect(all.made(b.send.id, "note-b")).toBe(true);
    expect(all.made(a.send.id, "note-a")).toBe(true);
    expect(all.uploadFor("ada", 1, "note-c")).toBeUndefined();
    // Another account or session generation never gets them.
    expect(all.uploadFor("bob", 1, "note-a")).toBeUndefined();
    expect(all.uploadFor("ada", 2, "note-a")).toBeUndefined();
    expect(all.uploadFor("ada", 1, "note-b")!.take()!.name).toBe("b.zip");
    expect(all.uploadFor("ada", 1, "note-a")!.take()!.name).toBe("a.zip");
    expect(all.list("ada", 1)).toEqual([]);
  });

  test("a made note's file waits a while; then it is reported, once", () => {
    vi.useFakeTimers();
    const { all, lost } = operations();
    const begun = all.begin(scope, file("a.zip"), note("a.zip"));
    if (!("send" in begun)) throw new Error("not sent");
    all.made(begun.send.id, "note-a");
    const upload = all.uploadFor("ada", 1, "note-a")!;
    vi.advanceTimersByTime(1_000);
    expect(lost.map((operation) => operation.noteId)).toEqual(["note-a"]);
    expect(upload.take()).toBeNull();
    expect(all.uploadFor("ada", 1, "note-a")).toBeUndefined();
  });

  test("another session ends operations quietly; files off ends them, reported", () => {
    const { all, lost } = operations();
    all.begin(scope, file("a.zip"), note("a.zip"));
    all.follow("ada", 2);
    expect(all.list("ada", 1)).toEqual([]);
    expect(lost).toEqual([]);
    const begun = all.begin(
      { accountId: "ada", generation: 2 },
      file("b.zip"),
      note("b.zip"),
    );
    if (!("send" in begun)) throw new Error("not sent");
    all.clear();
    expect(lost.map((operation) => operation.title)).toEqual(["b.zip"]);
    // A late answer for an ended operation opens nothing.
    expect(all.made(begun.send.id, "note-b")).toBe(false);
  });

  test("Remove ends an operation; a refusal does too", () => {
    const { all } = operations();
    const begun = all.begin(scope, file("a.zip"), note("a.zip"));
    if (!("send" in begun)) throw new Error("not sent");
    all.remove(begun.send.id);
    expect(all.list("ada", 1)).toEqual([]);
    // The same file afterwards is a new operation, with a new key.
    const again = all.begin(scope, file("a.zip"), note("a.zip"));
    expect("send" in again && again.send.key).toBe("key-2");
  });
});
