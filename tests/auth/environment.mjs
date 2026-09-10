import assert from "node:assert/strict";
import { frontendOrigin } from "../../scripts/local-auth-origin.mjs";

// Check the target before generating or submitting even disposable credentials.
const response = await fetch(frontendOrigin, {
  signal: AbortSignal.timeout(5000),
  redirect: "error",
});
assert(response.ok, "Palladian test frontend must be available");
assert(
  /<title>Palladian<\/title>/.test(await response.text()),
  "Test origin is not the Palladian frontend; refusing fixture sign-in",
);
export { frontendOrigin };
