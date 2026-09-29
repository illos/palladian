import { expect, test } from "@playwright/test";

/** Production preview; synthetic account cache is seeded through browser IDB, never a production fixture API. */
test("production shell reloads cached notes with all network unavailable", async ({
  page,
  context,
}, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "All notes" })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          () => resolve(),
          { once: true },
        );
      });
  });
  expect(await page.evaluate(() => "__notesHarness" in window)).toBe(false);
  await page.evaluate(async () => {
    const open = indexedDB.open("palladian-notes-foundation");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const accountId = "offline-proof-account";
    const id = "offline-proof-note";
    const lines = [
      "Offline shell proof",
      "Cached text appears without authentication or network.",
      "Synthetic content for a browser-only test.",
    ];
    const transaction = db.transaction(
      ["accounts", "summaries", "bodies"],
      "readwrite",
    );
    transaction
      .objectStore("accounts")
      .put({ accountId, epoch: 1, blocked: false });
    transaction.objectStore("summaries").put({
      accountId,
      id,
      title: lines[0],
      preview: lines[1],
      updatedAt: 1700000000000,
      kind: "cached",
    });
    transaction.objectStore("bodies").put({
      accountId,
      id,
      text: lines.join("\n"),
      document: JSON.stringify({
        type: "doc",
        content: lines.map((text) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        })),
      }),
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    localStorage.setItem(
      "palladian.notes.account-hint.v1",
      JSON.stringify({ accountId, signedOut: false }),
    );
  });
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("button", { name: /Offline shell proof/ }),
  ).toBeVisible();
  const libraryMs = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: /Offline shell proof/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Cached text appears without authentication or network.");
  const noteMs = await page.evaluate(() => performance.now());
  await expect(page.getByText("Cached copy — read only")).toBeVisible();
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller !== null),
  ).toBe(true);
  const cachedRequests = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith("palladian-notes-shell-")) continue;
      for (const request of await (await caches.open(name)).keys())
        result.push(new URL(request.url).pathname);
    }
    return result;
  });
  expect(cachedRequests.some((path) => path === "/index.html")).toBe(true);
  expect(
    cachedRequests.every(
      (path) =>
        path === "/" ||
        path === "/index.html" ||
        path === "/manifest.webmanifest" ||
        path.startsWith("/assets/"),
    ),
  ).toBe(true);
  testInfo.annotations.push({
    type: "desktop-probe",
    description: `Offline reload to visible library ${libraryMs.toFixed(1)}ms; cached note after navigation ${noteMs.toFixed(1)}ms from navigation start. Includes browser automation overhead; not an iPhone budget.`,
  });
  console.log(
    JSON.stringify({
      evidence: "desktop-production-offline-probe",
      libraryMs: Number(libraryMs.toFixed(1)),
      noteMs: Number(noteMs.toFixed(1)),
      realIPhone: false,
      actualAuthService: false,
    }),
  );
  await context.setOffline(false);
});
