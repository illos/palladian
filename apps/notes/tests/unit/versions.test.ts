import { describe, expect, test } from "vitest";
import {
  canRestore,
  kindLabels,
  pageChain,
  pageKey,
  previousRevision,
  restoreHold,
  RestoreRequests,
  versionKey,
  type Version,
  type VersionPageResult,
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

describe("restore hold (review round 1, F1 and F2)", () => {
  const ready = { connected: true, open: null, journaled: false };

  test("restores when the note has nothing unsent here", () => {
    expect(restoreHold(ready)).toBeNull();
    expect(
      restoreHold({ ...ready, open: { kind: "live", status: "saved" } }),
    ).toBeNull();
    // Read-only views have no typing of their own.
    expect(
      restoreHold({ ...ready, open: { kind: "cached", status: null } }),
    ).toBeNull();
  });

  test("waits while the open editor has typing not yet confirmed", () => {
    for (const status of [
      "saving",
      "syncing",
      "offline",
      "blocked",
      null,
    ] as const)
      expect(restoreHold({ ...ready, open: { kind: "live", status } })).toBe(
        "unsaved",
      );
    // A local draft view of the note: its changes are only on this device.
    expect(
      restoreHold({ ...ready, open: { kind: "draft", status: null } }),
    ).toBe("unsaved");
  });

  test("waits while unsent edits are journaled, open or not", () => {
    expect(restoreHold({ ...ready, journaled: true })).toBe("unsaved");
    expect(
      restoreHold({
        ...ready,
        journaled: true,
        open: { kind: "live", status: "saved" },
      }),
    ).toBe("unsaved");
  });

  test("waits for the connection first", () => {
    expect(restoreHold({ ...ready, connected: false })).toBe("offline");
    expect(
      restoreHold({
        connected: false,
        journaled: true,
        open: { kind: "live", status: "saving" },
      }),
    ).toBe("offline");
  });
});

describe("version pages (review round 1, F4)", () => {
  const version = (revision: number): Version => ({
    revision,
    baseRevision: revision - 1,
    kind: "edit",
    actorId: "p1" as Version["actorId"],
    actorName: "Ada",
    actorKind: "human",
    startedAt: revision,
    endedAt: revision,
    deviceTime: null,
  });
  /** The server's answer for a cursor, over revisions `newest`…1. */
  const page = (
    newest: number,
    before: number | undefined,
    limit = 30,
  ): VersionPageResult => {
    const top = Math.min(newest, (before ?? Infinity) - 1);
    const versions = Array.from(
      { length: Math.max(0, Math.min(limit, top)) },
      (_, i) => version(top - i),
    );
    return {
      versions,
      nextBefore:
        versions.length === limit
          ? versions[versions.length - 1]!.revision
          : null,
    };
  };
  const revisions = (versions: Version[]) => versions.map((v) => v.revision);
  const range = (from: number, to: number) =>
    Array.from({ length: from - to + 1 }, (_, i) => from - i);

  test("asks for each page from where the page above ends", () => {
    const one = pageChain(1, { [pageKey(undefined)]: page(60, undefined) });
    expect(one.cursors).toEqual([undefined]);
    expect(revisions(one.versions)).toEqual(range(60, 31));
    expect(one.end).toBe("more");
    const two = pageChain(2, {
      [pageKey(undefined)]: page(60, undefined),
      [pageKey(31)]: page(60, 31),
    });
    expect(two.cursors).toEqual([undefined, 31]);
    expect(revisions(two.versions)).toEqual(range(60, 1));
    // A full page always has a cursor; the server finds nothing older.
    expect(two.end).toBe("more");
    const three = pageChain(3, {
      [pageKey(undefined)]: page(60, undefined),
      [pageKey(31)]: page(60, 31),
      [pageKey(1)]: page(60, 1),
    });
    expect(three.cursors).toEqual([undefined, 31, 1]);
    expect(revisions(three.versions)).toEqual(range(60, 1));
    expect(three.end).toBe("done");
  });

  test("a new version shows the next page as loading, not stale", () => {
    // Revision 61 arrives: the newest page is now 61…32, so page two must
    // start before 32. Its result for the old cursor (30…1) would skip 31.
    const chain = pageChain(2, {
      [pageKey(undefined)]: page(61, undefined),
      [pageKey(31)]: page(60, 31),
    });
    expect(chain.cursors).toEqual([undefined, 32]);
    expect(revisions(chain.versions)).toEqual(range(61, 32));
    expect(chain.end).toBe("loading");
    // Once page two loads at its new cursor, the list is whole again.
    const settled = pageChain(2, {
      [pageKey(undefined)]: page(61, undefined),
      [pageKey(32)]: page(61, 32),
    });
    // Revision 1 is now on a third page.
    expect(revisions(settled.versions)).toEqual(range(61, 2));
    expect(settled.end).toBe("more");
  });

  test("the shown versions never skip or repeat while pages load", () => {
    for (let newest = 1; newest <= 95; newest++)
      for (let pages = 1; pages <= 4; pages++)
        for (let stale = 0; stale <= 3; stale++) {
          // Pages loaded when there were `newest - stale` versions, the
          // newest page up to date.
          const results: Record<string, VersionPageResult> = {
            [pageKey(undefined)]: page(newest, undefined),
          };
          let before = page(newest - stale, undefined).nextBefore;
          while (before !== null) {
            results[pageKey(before)] = page(newest - stale, before);
            before = results[pageKey(before)]!.nextBefore;
          }
          const shown = revisions(pageChain(pages, results).versions);
          expect(shown).toEqual(range(newest, newest - shown.length + 1));
        }
  });

  test("no versions, and a first page still loading", () => {
    expect(pageChain(1, { [pageKey(undefined)]: page(0, undefined) })).toEqual({
      cursors: [undefined],
      versions: [],
      end: "done",
    });
    expect(pageChain(3, {})).toEqual({
      cursors: [undefined],
      versions: [],
      end: "loading",
    });
  });
});
