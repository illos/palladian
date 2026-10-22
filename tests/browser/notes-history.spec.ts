import { expect, test } from "@playwright/test";

// History reads the server's revisions, so it is offered only while the
// server is reachable, and only to editors (plan 08, A4; D13). Fixture mode
// has no server, so these are the offline cases: connecting, unreachable, and
// signed in before the live connection is ready. Readers and the panel itself
// are covered against real services by apps/notes/scripts/history-e2e.mjs.
for (const session of ["stall", "transient", "ready"]) {
  test(`History is not offered without the server (session ${session})`, async ({
    page,
  }) => {
    await page.goto("/?fixture=seed&session=" + session);
    const row = page.getByRole("button", { name: /^Welcome to your notes/ });
    await expect(row).toBeVisible();
    const menu = page.getByRole("dialog", {
      name: "Actions for Welcome to your notes",
    });

    // The row's menu (the sheet on phones), opened from the keyboard.
    await row.focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Export as Markdown",
      "Print or save as PDF",
    ]);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // The open note: no toolbar button, nothing under "…".
    await row.click();
    await expect(
      page.getByRole("textbox", { name: "Note content" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Note history" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "History" })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(page.getByRole("dialog", { name: /^History of/ })).toHaveCount(
      0,
    );
  });
}
