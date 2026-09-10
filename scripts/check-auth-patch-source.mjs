// Strictly check the patched adapter's two runtime TypeScript sources against
// its installed published dependencies. Import server-only types through the
// supported package exports to avoid compiling unrelated upstream server source.
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const adapter = realpathSync(
  join(root, "node_modules/@convex-dev/better-auth"),
);
const dependencies = dirname(dirname(adapter));
const fetch = realpathSync(join(dependencies, "@better-fetch/fetch"));
const helpers = realpathSync(join(dependencies, "convex-helpers"));
const temporary = mkdtempSync(join(root, ".auth-patch-check-"));
try {
  const source = readFileSync(
    join(adapter, "src/plugins/cross-domain/client.ts"),
    "utf8",
  )
    .replace('"./index.js"', '"@convex-dev/better-auth/plugins"')
    .replace(
      'import { VERSION } from "../../version.js";',
      'const VERSION = "0.12.5";',
    )
    .replace(
      '"@better-fetch/fetch"',
      JSON.stringify(join(fetch, "dist/index.js")),
    );
  writeFileSync(join(temporary, "client.ts"), source);
  const provider = readFileSync(join(adapter, "src/react/index.tsx"), "utf8")
    .replace(
      '"../client/plugins/index.js"',
      '"@convex-dev/better-auth/client/plugins"',
    )
    .replace('"convex-helpers"', JSON.stringify(join(helpers, "index.js")));
  writeFileSync(join(temporary, "provider.tsx"), provider);
  writeFileSync(
    join(temporary, "tsconfig.json"),
    JSON.stringify({
      extends: "../tsconfig.web.json",
      include: ["client.ts", "provider.tsx"],
    }),
  );
  const result = spawnSync(
    join(root, "node_modules/.bin/tsc"),
    ["-p", join(temporary, "tsconfig.json")],
    { cwd: root, stdio: "inherit" },
  );
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
