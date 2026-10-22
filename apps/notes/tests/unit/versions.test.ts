import { describe, expect, test } from "vitest";
import {
  canRestore,
  kindLabels,
  previousRevision,
  RestoreRequests,
  versionKey,
} from "../../src/versions";

describe("versions", () => {
  test("each kind has a label", () => {
    expect(kindLabels).toEqual({
      create: "Created",
      edit: "Edited",
      restore: "Restored a version",
    });
  });

  test("a version keeps its key while its author keeps typing", () => {
    // The server extends the newest edit's revision; its start stays.
    expect(versionKey({ kind: "edit", baseRevision: 4 })).toBe("from-4");
    // Creation and the first edit both start at revision 0.
    expect(versionKey({ kind: "create", baseRevision: 0 })).not.toBe(
      versionKey({ kind: "edit", baseRevision: 0 }),
    );
    expect(versionKey({ kind: "restore", baseRevision: 9 })).toBe("from-9");
  });

  test("vs Previous compares with the note before the version", () => {
    expect(previousRevision({ kind: "edit", baseRevision: 12 })).toBe(12);
    expect(previousRevision({ kind: "restore", baseRevision: 30 })).toBe(30);
    // Nothing came before creation.
    expect(previousRevision({ kind: "create", baseRevision: 0 })).toBeNull();
  });

  test("only an earlier state can be restored", () => {
    expect(canRestore({ revision: 3 }, 8)).toBe(true);
    expect(canRestore({ revision: 8 }, 8)).toBe(false);
    expect(canRestore({ revision: 3 }, undefined)).toBe(false);
  });
});

describe("restore requests", () => {
  const ids = () => {
    let n = 0;
    return () => `request-${++n}`;
  };

  test("a retry repeats the unanswered request exactly", () => {
    const requests = new RestoreRequests(ids());
    const first = requests.next(3, 10);
    expect(first).toEqual({
      revision: 3,
      expectedRevision: 10,
      requestId: "request-1",
    });
    // No answer (the connection dropped); the note has moved on since.
    expect(requests.next(3, 12)).toEqual(first);
  });

  test("after an answer, the next restore is a new request", () => {
    const requests = new RestoreRequests(ids());
    const first = requests.next(3, 10);
    // A conflict: the note changed. Trying again expects the new revision.
    requests.settled(first);
    expect(requests.next(3, 12)).toEqual({
      revision: 3,
      expectedRevision: 12,
      requestId: "request-2",
    });
  });

  test("another version is another request", () => {
    const requests = new RestoreRequests(ids());
    requests.next(3, 10);
    expect(requests.next(5, 10).requestId).toBe("request-2");
    // A late answer for a replaced request does not drop the current one.
    const current = requests.next(5, 10);
    requests.settled({
      revision: 3,
      expectedRevision: 10,
      requestId: "request-1",
    });
    expect(requests.next(5, 11)).toBe(current);
  });
});
