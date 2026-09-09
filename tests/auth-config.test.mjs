import test from "node:test";
import assert from "node:assert/strict";
import {
  requireAuthSecret,
  requireFrontendOrigin,
} from "../convex/platform/config.ts";
test("auth configuration accepts exact HTTPS origins and loopback development only", () => {
  for (const origin of [
    "https://palladian.example",
    "https://palladian.example:8443",
    "http://localhost:5173",
  ]) {
    assert.equal(requireFrontendOrigin(origin), origin);
  }
});
test("auth configuration rejects wildcard, credential-bearing and non-origin trust entries", () => {
  for (const origin of [
    undefined,
    "*",
    "https://*.example.com",
    "https://%2a.example.com",
    "https://user:password@example.com",
    "https://example.com/callback",
    "https://example.com/",
    "https://example.com?next=evil",
    "http://example.com",
    "file://localhost",
    "ftp://localhost",
    "ws://localhost:5173",
    "https://EXAMPLE.com",
  ]) {
    assert.throws(() => requireFrontendOrigin(origin));
  }
});

test("auth requires an explicit sufficiently long secret and never uses a default", () => {
  for (const missing of [undefined, "", "short-fixture-value"])
    assert.throws(() => requireAuthSecret(missing));
  assert(requireAuthSecret("x".repeat(32)).length === 32);
});
