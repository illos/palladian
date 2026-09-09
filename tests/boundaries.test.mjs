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

const importForms = [
  (specifier) => `import * as dependency from ${JSON.stringify(specifier)};`,
  (specifier) => `export * from ${JSON.stringify(specifier)};`,
  (specifier) => `const dependency = import(${JSON.stringify(specifier)});`,
];

test("reject server auth entry points and all builtin import spellings", async () => {
  const { builtinModules } = await import("node:module");
  const builtins = new Set(
    builtinModules.flatMap((name) => [
      name,
      `node:${name.replace(/^node:/, "")}`,
    ]),
  );
  for (const specifier of [
    ...builtins,
    "node:test",
    "better-auth",
    "better-auth/minimal",
    "better-auth/plugins",
    "better-auth/adapters",
    "@convex-dev/better-auth",
    "@convex-dev/better-auth/plugins",
  ]) {
    for (const form of importForms) {
      for (const file of [
        "apps/web/src/apps/notes/entry.tsx",
        "apps/web/src/auth/client.ts",
      ]) {
        assert(
          violations(file, form(specifier)).length > 0,
          `${file} accepted ${form(specifier)}`,
        );
      }
    }
  }
});

test("allow only explicit client auth entry points within host auth integration", () => {
  for (const specifier of [
    "better-auth/react",
    "better-auth/client",
    "better-auth/client/plugins",
    "@convex-dev/better-auth/react",
    "@convex-dev/better-auth/client/plugins",
  ]) {
    for (const form of importForms) {
      assert.deepEqual(
        violations("apps/web/src/auth/client.ts", form(specifier)),
        [],
      );
      for (const file of [
        "apps/web/src/apps/notes/entry.tsx",
        "apps/web/src/main.tsx",
        "packages/app-sdk/src/index.ts",
      ]) {
        assert(
          violations(file, form(specifier)).length > 0,
          `${file} accepted ${specifier}`,
        );
      }
    }
  }
  assert(
    violations(
      "apps/web/src/auth/client.ts",
      'import * as x from "better-auth/client/unreviewed";',
    ).length > 0,
  );
});
