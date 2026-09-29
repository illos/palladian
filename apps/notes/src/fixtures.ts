import type { NotesStore } from "./cache";
import { textDocument } from "./document";
/** Disposable synthetic records only. Caller must gate this module to development. */
export async function seedFixture(store: NotesStore, accountId: string) {
  await store.allowAccount(
    accountId,
    await store.captureActivationFence(),
    () => true,
  );
  const fence = await store.captureFence(accountId);
  await store.cacheAccepted(
    {
      accountId,
      id: "fixture-welcome",
      document: textDocument([
        "Welcome to your notes",
        "This text comes from IndexedDB. Opening it does not need a session token.",
        "Live collaboration and server persistence are separate foundation gates.",
      ]),
      text: "Welcome to your notes\nThis text comes from IndexedDB. Opening it does not need a session token.\nLive collaboration and server persistence are separate foundation gates.",
    },
    1700000000000,
    fence,
  );
  const longLines = [
    "A longer note",
    ...Array.from(
      { length: 180 },
      (_, index) =>
        `Paragraph ${index + 1}. Continuous text for scrolling and selection in the editor foundation.`,
    ),
  ];
  await store.cacheAccepted(
    {
      accountId,
      id: "fixture-long",
      document: textDocument(longLines),
      text: longLines.join("\n"),
    },
    1699999999999,
    fence,
  );
}
