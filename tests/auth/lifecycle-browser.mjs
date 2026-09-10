// Playwright's normal focus emulation keeps pages visible and makes the CDP
// frozen state a no-op. Use the supported noDefaults connection option.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

export async function launchLifecycleBrowser() {
  const profile = await mkdtemp(join(tmpdir(), "palladian-lifecycle-"));
  const process = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      "--no-sandbox",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let stopped = false;
  let spawnFailed = false;
  process.once("error", () => {
    spawnFailed = true;
  });
  const finished = new Promise((resolve) => {
    process.once("close", () => {
      stopped = true;
      resolve();
    });
  });
  let browser;
  async function close() {
    if (browser) {
      const cdp = await browser.newBrowserCDPSession().catch(() => null);
      await cdp?.send("Browser.close").catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    if (!stopped) {
      process.kill();
      const timeout = setTimeout(() => process.kill("SIGKILL"), 5000);
      await finished;
      clearTimeout(timeout);
    }
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
  try {
    let port;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = await readFile(
        join(profile, "DevToolsActivePort"),
        "utf8",
      ).catch(() => null);
      if (value) {
        port = Number(value.split("\n")[0]);
        break;
      }
      assert(!spawnFailed && !stopped, "Lifecycle browser stopped at startup");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(
      Number.isSafeInteger(port) && port > 0,
      "Lifecycle browser unavailable",
    );
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      noDefaults: true,
    });
    return { browser, context: browser.contexts()[0], close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function prepareSuspension(context, page) {
  const events = [];
  await page.exposeFunction("palladianLifecycleProbe", (event) => {
    if (["freeze", "resume", "timer"].includes(event))
      events.push({ event, at: Date.now() });
  });
  await page.evaluate(() => {
    for (const event of ["freeze", "resume"])
      document.addEventListener(event, () => {
        void window.palladianLifecycleProbe(event);
      });
  });
  const foreground = await context.newPage();
  await foreground.goto("about:blank");
  await foreground.bringToFront();
  await page.waitForFunction(() => document.visibilityState === "hidden");
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => {
    setTimeout(() => void window.palladianLifecycleProbe("timer"), 1000);
  });
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
  const deadline = Date.now() + 3000;
  while (
    !events.some(({ event }) => event === "freeze") &&
    Date.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(
    events.some(({ event }) => event === "freeze"),
    "Actual freeze event required",
  );
  return {
    events,
    async resume() {
      assert(
        !events.some(({ event }) => event === "timer"),
        "Timer must remain suspended",
      );
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      await page.bringToFront();
      await page.waitForFunction(() => document.visibilityState === "visible");
      await foreground.close();
    },
  };
}
