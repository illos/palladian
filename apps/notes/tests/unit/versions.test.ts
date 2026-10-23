import { describe, expect, test } from "vitest";
import { notesSchema } from "@palladian/notes-core/schema";
import {
  COPY_NEEDS_FILES_MESSAGE,
  copyFailureMessage,
  copyNeedsFiles,
  isFilesOffRefusal,
  kindLabels,
  pageChain,
  pageKey,
  previousRevision,
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

describe("restoring a version as a new note while files are off (B1+B2)", () => {
  const text = (value: string) =>
    notesSchema.node("paragraph", null, notesSchema.text(value));
  const file = (objectId: string) =>
    notesSchema.node("file", { objectId, name: "a.pdf" });
  const image = (width: number | null) =>
    notesSchema.node("image", { src: "https://example.test/a.png", width });
  const doc = (...blocks: ReturnType<typeof text>[]) =>
    notesSchema.node("doc", null, [text("Title"), ...blocks]);

  test("plain versions copy whether files are on or off", () => {
    expect(copyNeedsFiles(doc(text("old")), doc(), false)).toBe(false);
    expect(copyNeedsFiles(doc(text("old")), null, false)).toBe(false);
  });

  test("file content the note no longer has waits for files", () => {
    expect(copyNeedsFiles(doc(file("o1")), doc(), false)).toBe(true);
    expect(copyNeedsFiles(doc(image(300)), doc(image(null)), false)).toBe(true);
    // Once files are on, the server accepts it.
    expect(copyNeedsFiles(doc(file("o1")), doc(), true)).toBe(false);
  });

  test("file content the note still has copies now", () => {
    expect(copyNeedsFiles(doc(file("o1")), doc(file("o1")), false)).toBe(false);
    expect(copyNeedsFiles(doc(image(300)), doc(image(300)), false)).toBe(false);
  });

  test("the server's refusal is recognised, other refusals are not", () => {
    expect(
      isFilesOffRefusal({
        code: "invalid",
        message: "Files and image sizes are not enabled on this server yet.",
      }),
    ).toBe(true);
    expect(
      isFilesOffRefusal({ code: "invalid", message: "Invalid client key." }),
    ).toBe(false);
    expect(
      isFilesOffRefusal({ code: "not_found", message: "Note not found." }),
    ).toBe(false);
  });

  test("a failed restore is worded the same for the panel and the toast", () => {
    expect(
      copyFailureMessage({
        code: "invalid",
        message: "File blocks are not enabled on this server yet.",
      }),
    ).toBe(COPY_NEEDS_FILES_MESSAGE);
    expect(
      copyFailureMessage({ code: "denied", message: "You can only read." }),
    ).toBe("You can only read.");
    expect(
      copyFailureMessage({
        code: "transient",
        message: "Connection unavailable.",
      }),
    ).toBe("Connection unavailable.");
  });
});
