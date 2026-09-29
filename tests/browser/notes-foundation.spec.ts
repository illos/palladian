import { expect, test } from "@playwright/test";

async function seed(page: import("@playwright/test").Page, session = "stall") {
  await page.goto("/?fixture=seed&session=" + session);
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
}

test("cached library and text display while authentication is stalled", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Opening it does not need a session token");
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toHaveAttribute("contenteditable", "false");
  await expect(page.getByText("Cached copy — read only")).toBeVisible();
  await page.goto("/?fixture=1&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
});

test("new draft accepts typing while connecting and survives reload as local work", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.fill("A durable draft\nStill connecting");
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  await page.goto("/?fixture=1&session=stall");
  await page.getByRole("button", { name: /A durable draft/ }).click();
  await expect(editor).toContainText("Still connecting");
});

test("transient failures keep cached notes instead of signing out", async ({
  page,
}) => {
  await seed(page, "transient");
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Welcome to your notes");
});

test("confirmed expiry retains cache; confirmed revocation clears it", async ({
  page,
}) => {
  await seed(page, "expired");
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Welcome to your notes");
  await page.goto("/?fixture=1&session=revoked");
  await expect(page.getByRole("textbox", { name: "Note content" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toHaveCount(0);
  await page.goto("/?fixture=1&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toHaveCount(0);
});

test("same-account retry preserves the draft and subsequent save feedback", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "Library retry control is hidden while the mobile note is open.",
  );
  await seed(page);
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await editor.fill("Keep this draft");
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry connection" }).click();
  await expect(editor).toContainText("Keep this draft");
  await editor.press("End");
  await editor.pressSequentially(" after retry");
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  await expect(editor).toContainText("after retry");
});

test("account fences reject delayed accepted writes and cross-store stale activation", async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const modulePath = "/src/cache.ts";
    const module = (await import(
      modulePath
    )) as typeof import("../../apps/notes/src/cache");
    const name = "fence-proof-" + crypto.randomUUID();
    const first = module.createNotesStore(name);
    const second = module.createNotesStore(name);
    const activation = await first.captureActivationFence();
    await first.allowAccount("account-a", activation, () => true);
    const oldRequest = await first.captureFence("account-a");
    const oldActivation = await first.captureActivationFence();
    await second.clearAccount("account-a");
    let activationRejected = false;
    try {
      await first.allowAccount("account-a", oldActivation, () => true);
    } catch {
      activationRejected = true;
    }
    const fresh = await second.captureActivationFence();
    await second.allowAccount("account-a", fresh, () => true);
    let oldWriteRejected = false;
    try {
      await second.cacheAccepted(
        {
          accountId: "account-a",
          id: "late",
          document: '{"type":"doc","content":[{"type":"paragraph"}]}',
          text: "private",
        },
        1,
        oldRequest,
      );
    } catch {
      oldWriteRejected = true;
    }
    const rows = await second.list("account-a");
    first.close();
    second.close();
    return { activationRejected, oldWriteRejected, rows: rows.length };
  });
  expect(result).toEqual({
    activationRejected: true,
    oldWriteRejected: true,
    rows: 0,
  });
});

test("storage failures report unsaved typing instead of a successful save", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(async () => {
    const modulePath = "/src/cache.ts";
    const module = (await import(
      modulePath
    )) as typeof import("../../apps/notes/src/cache");
    module.NotesStore.prototype.writeDraft = async () => {
      throw new Error("Synthetic quota failure");
    };
  });
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await editor.fill("Keep this typing visible");
  await expect(
    page.getByText("Draft not saved — keep this window open"),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Local storage failed");
  await expect(editor).toContainText("Keep this typing visible");
});

test("home projection does not read every body", async ({ page }) => {
  await seed(page);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.get;
    const counts = { bodies: 0, drafts: 0 };
    Object.assign(window, { foundationReadCounts: counts });
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === "bodies") counts.bodies++;
      if (this.name === "drafts") counts.drafts++;
      return original.call(this, key);
    };
  });
  await page.goto("/?fixture=1&session=stall");
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            foundationReadCounts: { bodies: number; drafts: number };
          }
        ).foundationReadCounts,
    ),
  ).toEqual({ bodies: 0, drafts: 0 });
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { foundationReadCounts: { bodies: number } })
          .foundationReadCounts.bodies,
    ),
  ).toBe(1);
});

test("queued draft writes preserve order and remain separate from accepted cache", async ({
  page,
}) => {
  await seed(page);
  const result = await page.evaluate(async () => {
    const modulePath = "/src/cache.ts";
    const module = (await import(
      modulePath
    )) as typeof import("../../apps/notes/src/cache");
    const store = module.createNotesStore("draft-proof-" + crypto.randomUUID());
    const document = '{"type":"doc","content":[{"type":"paragraph"}]}';
    await store.allowAccount(
      "a",
      await store.captureActivationFence(),
      () => true,
    );
    const acceptedFence = await store.captureFence("a");
    await store.cacheAccepted(
      { accountId: "a", id: "note", document, text: "Accepted" },
      1,
      acceptedFence,
    );
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        store.writeDraft({
          accountId: "a",
          id: "note",
          document,
          text: "Draft " + index,
          updatedAt: index + 2,
        }),
      ),
    );
    await store.cacheAccepted(
      { accountId: "a", id: "note", document, text: "New accepted" },
      40,
      acceptedFence,
    );
    const read = await store.read("a", "note");
    const wrongAccount = await store.read("b", "note");
    const rows = await store.list("a");
    store.close();
    return {
      text: read?.text,
      wrongAccount: wrongAccount === undefined,
      kind: rows[0]?.kind,
    };
  });
  expect(result).toEqual({
    text: "Draft 29",
    wrongAccount: true,
    kind: "draft",
  });
});

test("continuous note supports a selection spanning paragraphs", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  const selection = await editor.evaluate((element) => {
    const paragraphs = element.querySelectorAll("p");
    const first = paragraphs[0]?.firstChild;
    const last = paragraphs[2]?.firstChild;
    if (!first || !last) throw new Error("Fixture paragraphs missing");
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString();
  });
  expect(selection).toContain("Welcome to your notes");
  expect(selection).toContain("Live collaboration and server persistence");
});

test("hash header plus Tab creates a native heading", async ({ page }) => {
  await seed(page);
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Note content" });
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.fill("#HEADER");
  await editor.press("Tab");
  await expect(editor.locator("h1")).toHaveText("HEADER");
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
});

test("another tab's revocation removes visible cached content", async ({
  page,
  context,
}) => {
  await seed(page);
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toBeVisible();
  const other = await context.newPage();
  await other.goto("/?fixture=1&session=stall");
  await other.evaluate(async () => {
    const modulePath = "/src/cache.ts";
    const module = (await import(
      modulePath
    )) as typeof import("../../apps/notes/src/cache");
    const store = module.createNotesStore();
    await store.clearAccount("fixture-account");
    store.close();
  });
  await expect(page.getByRole("textbox", { name: "Note content" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /Welcome to your notes/ }),
  ).toHaveCount(0);
  await other.close();
});

test("cached text and draft typing do not wait for the rich editor chunk", async ({
  page,
}) => {
  await page.route("**/src/editor.tsx*", (route) => route.abort("failed"));
  await seed(page);
  await page.getByRole("button", { name: /Welcome to your notes/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Note content" }),
  ).toContainText("Opening it does not need a session token");
  const back = page.getByRole("button", { name: "‹ All notes" });
  if (await back.isVisible()) await back.click();
  await page
    .getByRole("button", { name: "New note", exact: true })
    .first()
    .click();
  const text = page.getByRole("textbox", { name: "Note content" });
  await text.fill("Immediate plain draft");
  await expect(
    page.getByText("Draft saved on this device — not saved to server"),
  ).toBeVisible();
  await expect(text).toHaveValue("Immediate plain draft");
});

test("rich recovery drafts keep formatting when the editor chunk is unavailable", async ({
  page,
}) => {
  await page.route("**/src/editor.tsx*", (route) => route.abort("failed"));
  await seed(page);
  await page.evaluate(async () => {
    const modulePath = "/src/cache.ts";
    const module = (await import(
      modulePath
    )) as typeof import("../../apps/notes/src/cache");
    const store = module.createNotesStore();
    await store.writeDraft({
      accountId: "fixture-account",
      id: "rich-draft",
      text: "Rich recovery",
      document: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [
              {
                type: "text",
                text: "Rich recovery",
                marks: [{ type: "strong" }],
              },
            ],
          },
        ],
      }),
      updatedAt: Date.now(),
    });
    store.close();
  });
  await page.reload();
  await page.getByRole("button", { name: /Rich recovery/ }).click();
  const viewer = page.getByRole("textbox", { name: "Note content" });
  await expect(viewer).toHaveAttribute("contenteditable", "false");
  await expect(viewer).toContainText("Rich recovery");
  await expect(
    page.getByText(
      "This formatted draft will be editable when formatting is ready.",
    ),
  ).toBeVisible();
  const preserved = await page.evaluate(async () => {
    const modulePath = "/src/cache.ts";
    const module = (await import(
      modulePath
    )) as typeof import("../../apps/notes/src/cache");
    const store = module.createNotesStore();
    const note = await store.read("fixture-account", "rich-draft");
    store.close();
    return note?.document;
  });
  expect(JSON.parse(preserved ?? "{}").content[0]).toEqual({
    type: "heading",
    attrs: { level: 1 },
    content: [
      { type: "text", text: "Rich recovery", marks: [{ type: "strong" }] },
    ],
  });
});
