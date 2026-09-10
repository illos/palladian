// Explicit dedicated-development target. Never reuse the anonymous-local helper
// or permit default/prod/environment deployment selection in hosted acceptance.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const hostedTarget = Object.freeze({
  checkout: "/srv/presidium/projects/palladian/hosted-dev",
  team: "jim-pringle",
  project: "palladian",
  reference: "dev/hosted-pilot",
  selector: "jim-pringle:palladian:dev/hosted-pilot",
  name: "necessary-lynx-217",
  type: "dev",
  isDefault: false,
  frontendOrigin: "https://palladian-development.rdxx.workers.dev",
  dataUrl: "https://necessary-lynx-217.convex.cloud",
  authUrl: "https://necessary-lynx-217.convex.site",
});

function cli(args) {
  const result = spawnSync(
    join(hostedTarget.checkout, "node_modules/.bin/convex"),
    [...args, "--deployment", hostedTarget.selector],
    {
      cwd: hostedTarget.checkout,
      env: { ...process.env },
      stdio: "pipe",
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert(
    result.status === 0,
    "Dedicated-dev command failed; output suppressed",
  );
  return result.stdout.trim();
}

export async function verifyHostedTarget() {
  assert.deepEqual(
    process.argv.slice(2),
    ["--target", hostedTarget.selector],
    "Hosted acceptance requires the exact explicit dedicated-dev target",
  );
  assert(
    !Object.keys(process.env).some((key) => key.startsWith("CONVEX_")),
    "Refusing inherited Convex credential or target overrides",
  );
  assert.equal(
    realpathSync(hostedTarget.checkout),
    hostedTarget.checkout,
    "Dedicated checkout must not redirect to another workspace",
  );
  const recorded = JSON.parse(
    readFileSync(
      join(
        hostedTarget.checkout,
        ".wrangler/palladian-development/identity.json",
      ),
      "utf8",
    ),
  );
  for (const key of [
    "team",
    "project",
    "reference",
    "name",
    "type",
    "isDefault",
    "frontendOrigin",
    "dataUrl",
    "authUrl",
  ])
    assert.equal(
      recorded[key],
      hostedTarget[key],
      `Recorded dedicated-dev ${key} differs`,
    );
  const local = new Map(
    readFileSync(join(hostedTarget.checkout, ".env.local"), "utf8")
      .split("\n")
      .flatMap((line) => {
        const match = /^([A-Z_]+)=(.*?)(?:\s+#.*)?$/.exec(line.trim());
        return match ? [[match[1], match[2]]] : [];
      }),
  );
  assert.equal(local.get("CONVEX_DEPLOYMENT"), `dev:${hostedTarget.name}`);
  assert.equal(local.get("VITE_CONVEX_URL"), hostedTarget.dataUrl);
  assert.equal(local.get("VITE_CONVEX_SITE_URL"), hostedTarget.authUrl);
  assert(
    ![...local.keys()].some((key) => /KEY|SECRET|TOKEN/.test(key)),
    "Public-only checkout environment required",
  );

  // Match the pinned CLI's official management API; credentials stay in memory.
  const global = JSON.parse(
    readFileSync(join(homedir(), ".convex/config.json"), "utf8"),
  );
  assert(
    typeof global.accessToken === "string" && global.accessToken.length > 0,
    "Existing operator login required",
  );
  async function metadata(path) {
    const response = await fetch(`https://api.convex.dev/v1/${path}`, {
      headers: { authorization: `Bearer ${global.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    assert(
      response.ok,
      "Dedicated-dev metadata unavailable; refusing fixtures",
    );
    return response.json();
  }
  const projectPath = `teams/${hostedTarget.team}/projects/${hostedTarget.project}`;
  const [project, deployment] = await Promise.all([
    metadata(projectPath),
    metadata(
      `${projectPath}/deployment?reference=${encodeURIComponent(hostedTarget.reference)}`,
    ),
  ]);
  assert.equal(project.slug, hostedTarget.project);
  assert.equal(project.teamSlug, hostedTarget.team);
  assert.equal(deployment.projectId, project.id);
  assert.equal(deployment.kind, "cloud");
  assert.equal(deployment.name, hostedTarget.name);
  assert.equal(deployment.reference, hostedTarget.reference);
  assert.equal(deployment.deploymentType, "dev");
  assert.equal(deployment.isDefault, false);
  assert.equal(deployment.deploymentUrl, hostedTarget.dataUrl);
  assert.equal(cli(["env", "get", "CONVEX_SITE_URL"]), hostedTarget.authUrl);
  assert.equal(cli(["env", "get", "SITE_URL"]), hostedTarget.frontendOrigin);
  const response = await fetch(hostedTarget.frontendOrigin, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, "Hosted frontend unavailable");
  const html = await response.text();
  assert(
    /<title>Palladian<\/title>/.test(html),
    "Expected Palladian frontend before provisioning",
  );
  assert(
    !html.includes("/@vite/client") && !html.includes("/src/"),
    "Hosted checks require a built frontend",
  );
  console.log(
    `Verified target: dedicated dev ${hostedTarget.selector} (${hostedTarget.name}); exact hosted HTTPS origins`,
  );
  let verified = true;
  return {
    provision(user) {
      assert(verified, "Target must be verified before each fixture batch");
      console.log(
        `target: dev ${hostedTarget.selector}; provision one disposable acceptance account`,
      );
      // Never print command argv, output, credentials or session information.
      cli([
        "run",
        "provision:owner",
        JSON.stringify(user),
        "--codegen",
        "disable",
      ]);
    },
    close() {
      verified = false;
    },
  };
}
