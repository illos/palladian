import assert from "node:assert/strict";
import { test } from "node:test";
import {
  instanceHref,
  resourceHref,
} from "../packages/contracts/src/routes.ts";

test("integrated and standalone paths preserve instance identity through title changes", () => {
  assert.equal(
    instanceHref("workspace-one", "instance-one", "integrated"),
    "/w/workspace-one/a/instance-one/",
  );
  assert.equal(
    instanceHref("workspace-one", "instance-one", "standalone"),
    "/a/instance-one/",
  );
});

test("resource paths retain the same scoped identity and escape data segments", () => {
  const target = {
    definitionId: "notes",
    instanceId: "instance-one",
    resourceType: "note",
    resourceId: "resource/one?query#fragment",
  };
  const suffix = "r/note/resource%2Fone%3Fquery%23fragment";
  assert.equal(
    resourceHref("workspace-one", target, "integrated"),
    `/w/workspace-one/a/instance-one/${suffix}`,
  );
  assert.equal(
    resourceHref("workspace-one", target, "standalone"),
    `/a/instance-one/${suffix}`,
  );
});
