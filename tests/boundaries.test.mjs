import { test } from "node:test";
import assert from "node:assert/strict";
import { violations } from "../scripts/check-boundaries.mjs";
test("reject relative, re-exported and dynamic server imports", () => {
  for (const source of [
    "import {x} from '../../../../convex/secrets';",
    "export * from '../../../../convex/secrets';",
    "const x=import('../../../../spikes/auth/convex/auth');",
  ])
    assert(violations("apps/web/src/apps/notes/entry.tsx", source).length);
});
test("reject sibling internals and eager app imports", () => {
  assert(
    violations(
      "apps/web/src/apps/notes/entry.tsx",
      "import {x} from '../recipes/entry';",
    ).length,
  );
  assert(
    violations("apps/web/src/main.tsx", "import {x} from './apps/notes/entry';")
      .length,
  );
  assert.equal(
    violations(
      "apps/web/src/registry.ts",
      "const load=()=>import('./apps/notes/entry');",
    ).length,
    0,
  );
});
test("reject computed imports and unsafe type suppressions", () => {
  assert(
    violations("apps/web/src/main.tsx", "const load=(url:string)=>import(url);")
      .length,
  );
  assert(
    violations("packages/app-sdk/src/index.ts", "export type Escape = any;")
      .length,
  );
});
