import { afterEach, describe, expect, test } from "vitest";
import {
  describeFailure,
  forgetSecrets,
  redact,
  secret,
} from "../../scripts/redact.mjs";
import { devTarget, parseEnvFile } from "../../scripts/dev-target.mjs";

// Review round 2 (R2-2, R2-3): what real-service scripts may print, and the
// one development deployment they may touch. Canary values stand in for real
// ones; none of them may survive into output.
const INVITE = "Zx9Kq2Lm7Np4Rs1Tv8Wy3Ab6Cd0Ef5Gh";
const PASSWORD = "pA55-w0rd_canary_9f3b2c7d1e";
const JWT =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlLWNhbmFyeS12YWx1ZQ";
const DEPLOY_KEY = "prod:happy-otter-123|canaryDeployKeyValue0123456789";

afterEach(() => forgetSecrets());

describe("redact", () => {
  test("URLs keep their place, not their fragment or query", () => {
    const text = redact(
      `page.goto: net::ERR_ABORTED at http://localhost:5178/invite#${INVITE}`,
    );
    expect(text).not.toContain(INVITE);
    expect(text).toContain("http://localhost:5178/invite[…]");
    const reset = redact(
      `navigating to "https://notes.example/reset?token=${INVITE}&x=1"`,
    );
    expect(reset).not.toContain(INVITE);
    expect(reset).toContain("https://notes.example/reset[…]");
    const socket = redact(
      `wss://decisive-reindeer-520.convex.cloud/api/1.45.0/sync`,
    );
    expect(socket).toBe(
      "wss://decisive-reindeer-520.convex.cloud/api/1.45.0/sync",
    );
  });

  test("a URL keeps its form, and the sentence around it", () => {
    expect(
      redact(
        "CONVEX_CLOUD_URL must be https://decisive-reindeer-520.convex.cloud.",
      ),
    ).toBe(
      "CONVEX_CLOUD_URL must be https://decisive-reindeer-520.convex.cloud.",
    );
    expect(redact(`see https://user:${PASSWORD}@host.example/x?y=1.`)).toBe(
      "see https://[…]@host.example/x[…].",
    );
  });

  test("opaque path segments, JWTs and bearer credentials are hidden", () => {
    const text = redact(
      `GET https://notes.example/p/${INVITE} with Authorization: Bearer ${JWT} and ${JWT}`,
    );
    expect(text).not.toContain(INVITE);
    expect(text).not.toContain(JWT);
    expect(text).not.toContain("c2lnbmF0dXJl");
    expect(text).toContain("https://notes.example/p/[id]");
  });

  test("password=, token: and similar values are hidden", () => {
    for (const line of [
      `password=${PASSWORD}`,
      `{"password":"${PASSWORD}"}`,
      `token: ${INVITE}`,
      `CONVEX_DEPLOY_KEY=${DEPLOY_KEY}`,
      `cookie=${INVITE}; Path=/`,
    ]) {
      const text = redact(line);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(INVITE);
      expect(text).not.toContain("canaryDeployKeyValue");
    }
  });

  test("registered secrets are hidden wherever they appear", () => {
    secret(PASSWORD);
    secret(INVITE);
    const text = redact(
      `fill("${PASSWORD}") failed; link was ${INVITE.slice(0, 10)}…${INVITE}`,
    );
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(INVITE);
    expect(text).toContain("[secret]");
  });

  test("a stray fragment without its URL is hidden", () => {
    expect(redact(`expected #${INVITE} to be visible`)).not.toContain(INVITE);
  });

  test("failures print their kind and a short, redacted message", () => {
    const failure = new Error(
      `page.goto: Timeout\nnavigating to "http://localhost:5178/invite#${INVITE}"\n${"call log line\n".repeat(20)}`,
    );
    failure.name = "TimeoutError";
    const text = describeFailure(failure);
    expect(text.startsWith("TimeoutError: page.goto: Timeout")).toBe(true);
    expect(text).not.toContain(INVITE);
    expect(text.split("\n").length).toBeLessThanOrEqual(8);
    expect(describeFailure(`raw ${JWT}`)).not.toContain(JWT);
  });
});

describe("development target", () => {
  const good = {
    CONVEX_DEPLOYMENT: "dev:decisive-reindeer-520",
    CONVEX_SITE_URL: "https://decisive-reindeer-520.convex.site",
    CONVEX_CLOUD_URL: "https://decisive-reindeer-520.convex.cloud",
    PATH: "/usr/bin",
  };

  test("one development deployment, named three ways", () => {
    expect(devTarget(good)).toEqual({
      name: "decisive-reindeer-520",
      deployment: "dev:decisive-reindeer-520",
      site: "https://decisive-reindeer-520.convex.site",
      cloud: "https://decisive-reindeer-520.convex.cloud",
    });
    // The CLI's own file may repeat the same target.
    expect(
      devTarget(good, {
        ".env.local": {
          CONVEX_DEPLOYMENT: "dev:decisive-reindeer-520",
          CONVEX_URL: "https://decisive-reindeer-520.convex.cloud",
          VITE_OTHER: "x",
        },
      }).name,
    ).toBe("decisive-reindeer-520");
  });

  test("refuses overrides in the environment, without printing them", () => {
    for (const [key, value] of [
      ["CONVEX_DEPLOY_KEY", DEPLOY_KEY],
      ["CONVEX_DEPLOYMENT_TOKEN", DEPLOY_KEY],
      ["CONVEX_SELF_HOSTED_URL", "https://convex.example"],
      ["CONVEX_SELF_HOSTED_ADMIN_KEY", DEPLOY_KEY],
      ["CONVEX_OVERRIDE_ACCESS_TOKEN", DEPLOY_KEY],
      ["CONVEX_PROVISION_HOST", "https://provision.example"],
      ["CONVEX_PROD", "1"],
      ["CONVEX_URL", "https://happy-otter-123.convex.cloud"],
    ] as const) {
      let message = "";
      try {
        devTarget({ ...good, [key]: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`${key} is set in the environment`);
      expect(message).not.toContain(value);
    }
  });

  test("refuses anything but dev:<name> with its exact URLs", () => {
    expect(() =>
      devTarget({ ...good, CONVEX_DEPLOYMENT: "prod:decisive-reindeer-520" }),
    ).toThrow(/must be dev:/);
    expect(() =>
      devTarget({ ...good, CONVEX_DEPLOYMENT: "decisive-reindeer-520" }),
    ).toThrow(/must be dev:/);
    expect(() =>
      devTarget({
        ...good,
        CONVEX_CLOUD_URL: "https://happy-otter-123.convex.cloud",
      }),
    ).toThrow(/CONVEX_CLOUD_URL must be/);
    expect(() =>
      devTarget({
        ...good,
        CONVEX_SITE_URL: "https://decisive-reindeer-520.convex.site/",
      }),
    ).toThrow(/CONVEX_SITE_URL must be/);
    const { CONVEX_SITE_URL: _site, ...noSite } = good;
    expect(() => devTarget(noSite)).toThrow(/CONVEX_SITE_URL must be/);
  });

  test("refuses overrides and conflicts in the CLI's env files", () => {
    const refused = (vars: Record<string, string>) => {
      try {
        devTarget(good, { ".env.local": vars });
      } catch (error) {
        return (error as Error).message;
      }
      return null;
    };
    expect(refused({ CONVEX_DEPLOY_KEY: DEPLOY_KEY })).toContain(
      "CONVEX_DEPLOY_KEY is set in .env.local",
    );
    expect(refused({ CONVEX_DEPLOY_KEY: DEPLOY_KEY })).not.toContain(
      "canaryDeployKeyValue",
    );
    expect(refused({ CONVEX_DEPLOYMENT: "prod:happy-otter-123" })).toContain(
      ".env.local sets a different CONVEX_DEPLOYMENT",
    );
    expect(
      refused({ CONVEX_URL: "https://happy-otter-123.convex.cloud" }),
    ).toContain(".env.local sets a different CONVEX_URL");
    expect(refused({ CONVEX_SOMETHING_NEW: "x" })).toContain(
      "CONVEX_SOMETHING_NEW is set in .env.local",
    );
  });

  test("reads env files as the CLI writes them", () => {
    expect(
      parseEnvFile(
        [
          "# Deployment used by `npx convex dev`",
          "CONVEX_DEPLOYMENT=dev:decisive-reindeer-520 # team: x",
          'CONVEX_URL="https://decisive-reindeer-520.convex.cloud"',
          "export CONVEX_DEPLOY_KEY='prod:x|y'",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      CONVEX_DEPLOYMENT: "dev:decisive-reindeer-520",
      CONVEX_URL: "https://decisive-reindeer-520.convex.cloud",
      CONVEX_DEPLOY_KEY: "prod:x|y",
    });
  });
});
