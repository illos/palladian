import "fake-indexeddb/auto";
import { markdownToDoc } from "@palladian/notes-core";
import { describe, expect, test } from "vitest";
import { NotesStore, type Draft } from "../../src/cache";

const json = (markdown: string) =>
  JSON.stringify(markdownToDoc(markdown).toJSON());
const body = {
  accountId: "account",
  id: "note",
  document: json("private"),
  text: "private",
  revision: 0,
};

describe("creation recovery conflicts", () => {
  const local = markdownToDoc("b".repeat(3000));
  const server = markdownToDoc("a".repeat(3000) + " and a collaborator");

  test("a split never replaces a draft that changed meanwhile", async () => {
    const store = new NotesStore("r4-" + crypto.randomUUID());
    try {
      const draft: Draft = {
        ...body,
        document: JSON.stringify(local.toJSON()),
        text: local.textContent,
        updatedAt: 1,
        created: true,
      };
      await store.writeDraft(draft);
      await store.writeDraft({ ...draft, text: "newer", updatedAt: 2 });
      const fence = await store.captureFence("account");
      const split = await store.splitConflict(
        draft,
        "local-copy",
        { ...body, document: JSON.stringify(server.toJSON()), revision: 3 },
        fence,
      );
      expect(split).toBe(false);
      expect((await store.readDraft("account", "note"))!.text).toBe("newer");
      expect(await store.readDraft("account", "local-copy")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
