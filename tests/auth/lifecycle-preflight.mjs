// No backend, credentials, or auth mocks: independently prove actual JS freeze.
import assert from "node:assert/strict";
import {
  launchLifecycleBrowser,
  prepareSuspension,
} from "./lifecycle-browser.mjs";
const runtime = await launchLifecycleBrowser();
try {
  const page = runtime.context.pages()[0];
  await page.goto("about:blank");
  const suspension = await prepareSuspension(runtime.context, page);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await suspension.resume();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const frozenAt = suspension.events.find(
    ({ event }) => event === "freeze",
  )?.at;
  const resumedAt = suspension.events.find(
    ({ event }) => event === "resume",
  )?.at;
  const timerAt = suspension.events.find(({ event }) => event === "timer")?.at;
  assert(resumedAt >= frozenAt + 2500, "Actual suspension interval required");
  assert(timerAt >= resumedAt, "Timer must execute only after resume");
  console.log(
    JSON.stringify({
      freezeObserved: true,
      resumeObserved: true,
      timerSuspended: true,
      actualSuspensionMs: resumedAt - frozenAt,
    }),
  );
} finally {
  await runtime.close();
}
