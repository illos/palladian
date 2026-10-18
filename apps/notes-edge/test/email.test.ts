import { describe, expect, it } from "vitest";
import {
  EMAIL_RELAY_PATH,
  handleEmailRelay,
  parseMessage,
  render,
  type EmailEnv,
} from "../src/email.ts";

const ORIGIN = "https://notes.example.com";
const SECRET = "relay-secret-0123456789abcdef0123456789";
const TOKEN = "A".repeat(43);

function relayEnv() {
  const sent: unknown[] = [];
  const env: EmailEnv = {
    PUBLIC_ORIGIN: ORIGIN,
    EMAIL_FROM: "notes@example.com",
    EMAIL_RELAY_SECRET: SECRET,
    EMAIL: {
      send: async (message: unknown) => {
        sent.push(message);
        return { messageId: "m1" };
      },
    } as SendEmail,
  };
  return { env, sent };
}

function post(body: unknown, secret = SECRET) {
  return new Request(ORIGIN + EMAIL_RELAY_PATH, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

const reset = {
  kind: "reset",
  to: "ada@example.com",
  url: `${ORIGIN}/reset#${TOKEN}`,
};

describe("account email relay", () => {
  it("sends a reset email from the configured sender", async () => {
    const { env, sent } = relayEnv();
    const response = await handleEmailRelay(post(reset), env);
    expect(response.status).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: "notes@example.com", name: "Palladian" },
      to: "ada@example.com",
      subject: "Reset your Palladian password",
    });
  });

  it("rejects a wrong or missing secret without sending", async () => {
    const { env, sent } = relayEnv();
    expect((await handleEmailRelay(post(reset, "wrong"), env)).status).toBe(
      401,
    );
    const bare = new Request(ORIGIN + EMAIL_RELAY_PATH, {
      method: "POST",
      body: JSON.stringify(reset),
    });
    expect((await handleEmailRelay(bare, env)).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("answers 503 until the binding, sender and secret are all configured", async () => {
    const { env } = relayEnv();
    delete env.EMAIL;
    expect((await handleEmailRelay(post(reset), env)).status).toBe(503);
  });

  it("only accepts POST", async () => {
    const { env } = relayEnv();
    const get = new Request(ORIGIN + EMAIL_RELAY_PATH);
    expect((await handleEmailRelay(get, env)).status).toBe(405);
  });

  it("reports a failed send without leaking details", async () => {
    const { env } = relayEnv();
    env.EMAIL = {
      send: async () => {
        throw Object.assign(new Error("ada@example.com rejected"), {
          code: "E_SENDER_NOT_VERIFIED",
        });
      },
    } as SendEmail;
    expect((await handleEmailRelay(post(reset), env)).status).toBe(502);
  });
});

describe("relay message validation", () => {
  it("refuses links to another origin or path", () => {
    for (const url of [
      `https://evil.example/reset#${TOKEN}`,
      `${ORIGIN}.evil.example/reset#${TOKEN}`,
      `${ORIGIN}/invite#${TOKEN}`,
      `${ORIGIN}/reset?token=${TOKEN}`,
      `${ORIGIN}/reset#${TOKEN}<script>`,
      `${ORIGIN}/reset#short`,
    ])
      expect(() => parseMessage({ ...reset, url }, ORIGIN)).toThrow();
  });

  it("refuses malformed recipients and unknown kinds", () => {
    for (const to of [
      "",
      "no-at-sign",
      "a@b",
      "x@y.z, z@evil.example",
      "a b@c.d",
    ])
      expect(() => parseMessage({ ...reset, to }, ORIGIN)).toThrow();
    expect(() =>
      parseMessage({ ...reset, kind: "marketing" }, ORIGIN),
    ).toThrow();
  });

  it("cleans and bounds invitation labels", () => {
    const message = parseMessage(
      {
        kind: "invite",
        to: "bo@example.com",
        url: `${ORIGIN}/invite#${TOKEN}`,
        inviterName: "Ada\u0000‮ Lovelace",
        target: "x".repeat(300),
      },
      ORIGIN,
    );
    expect(message).toMatchObject({ inviterName: "Ada Lovelace" });
    expect(message.kind === "invite" && message.target?.length).toBe(100);
  });
});

describe("email templates", () => {
  it("escapes names in HTML", () => {
    const content = render({
      kind: "invite",
      to: "bo@example.com",
      url: `${ORIGIN}/invite#${TOKEN}`,
      inviterName: "<b>Ada</b>",
      target: 'Plans & "ideas"',
    });
    expect(content.html).not.toContain("<b>Ada</b>");
    expect(content.html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
    expect(content.html).toContain("Plans &amp; &quot;ideas&quot;");
    expect(content.text).toContain(`${ORIGIN}/invite#${TOKEN}`);
  });

  it("words an owner setup link without an inviter", () => {
    const content = render({
      kind: "invite",
      to: "bo@example.com",
      url: `${ORIGIN}/invite#${TOKEN}`,
      inviterName: null,
      target: null,
    });
    expect(content.subject).toBe("Set up your Palladian account");
  });
});
