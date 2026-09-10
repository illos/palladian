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

test("host auth may import generated API and browser client, never server code", () => {
  for (const spec of ["convex/react", "../../../../convex/_generated/api"]) {
    assert.deepEqual(
      violations(
        "apps/web/src/auth/Runtime.tsx",
        `import { api } from "${spec}";`,
      ),
      [],
    );
    assert(
      violations(
        "apps/web/src/apps/notes/entry.tsx",
        `import { api } from "${spec}";`,
      ).length > 0,
    );
  }
  for (const spec of [
    "convex/server",
    "../../../../convex/auth",
    "../../../../convex/_generated/server",
  ]) {
    assert(
      violations(
        "apps/web/src/auth/Runtime.tsx",
        `import { query } from "${spec}";`,
      ).length > 0,
    );
  }
});

test("platform host can consume reactive API and generated ID types only", () => {
  const file = "apps/web/src/platform/Workspace.tsx";
  for (const source of [
    'import {useQuery} from "convex/react";',
    'import {api} from "../../../../convex/_generated/api.js";',
    'import type {Id} from "../../../../convex/_generated/dataModel";',
  ])
    assert.deepEqual(violations(file, source), []);
  for (const source of [
    'import {query} from "../../../../convex/_generated/server";',
    'import {auth} from "../../../../convex/auth";',
    'import {authClient} from "better-auth/react";',
    'import {Doc} from "../../../../convex/_generated/dataModel";',
  ])
    assert(violations(file, source).length);
});

test("server app modules require scope helper and reject sibling or auth internals", () => {
  const file = "convex/apps/notes/instances.ts";
  const scope = 'import {requireAppInstance} from "../../platform/scope";';
  assert.deepEqual(
    violations(file, scope + 'import {query} from "../../_generated/server";'),
    [],
  );
  for (const source of [
    "",
    'import type {requireAppInstance} from "../../platform/scope";',
    'export {requireAppInstance} from "../../platform/scope";',
  ])
    assert(violations(file, source).length);
  for (const spec of [
    "../recipes/instances",
    "../../auth",
    "node:fs",
    "better-auth",
    "../../_generated/api",
    "../recipes/instances.js",
  ])
    assert(violations(file, scope + `import * as x from "${spec}";`).length);
});
