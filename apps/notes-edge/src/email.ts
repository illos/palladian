/**
 * Account email relay. Better Auth runs in Convex, which cannot use the
 * Cloudflare email binding, so Convex posts here with a shared secret. The
 * relay only renders its own templates for links on this origin: a leaked
 * secret cannot send arbitrary content or link elsewhere.
 */
export const EMAIL_RELAY_PATH = "/internal/email";

export interface EmailEnv {
  PUBLIC_ORIGIN: string;
  /** Verified sender on the onboarded domain, e.g. `notes@example.com`. */
  EMAIL_FROM?: string;
  /** Secret shared with Convex (EMAIL_RELAY_SECRET there). */
  EMAIL_RELAY_SECRET?: string;
  EMAIL?: SendEmail;
}

export type RelayMessage =
  | { kind: "reset"; to: string; url: string }
  | {
      kind: "invite";
      to: string;
      url: string;
      inviterName: string | null;
      target: string | null;
    };

const MAX_BODY = 4096;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const TOKEN = /^[A-Za-z0-9_-]{16,100}$/;

function status(code: number): Response {
  return new Response(null, {
    status: code,
    headers: { "Cache-Control": "no-store" },
  });
}

async function sameSecret(given: string, expected: string): Promise<boolean> {
  const encode = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = (await Promise.all([encode(given), encode(expected)])).map(
    (digest) => new Uint8Array(digest),
  );
  // Equal-length digests compared without an early exit.
  let difference = 0;
  for (let i = 0; i < a!.length; i++) difference |= a![i]! ^ b![i]!;
  return difference === 0;
}

/** A short single-line label from the database: no control characters. */
function label(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("invalid label");
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ");
  return text.trim().slice(0, 100) || null;
}

function link(value: unknown, origin: string, path: string): string {
  if (typeof value !== "string") throw new Error("invalid link");
  const prefix = `${origin}${path}#`;
  if (!value.startsWith(prefix) || !TOKEN.test(value.slice(prefix.length)))
    throw new Error("invalid link");
  return value;
}

/** Validate a relay request against this origin. Throws on anything else. */
export function parseMessage(value: unknown, origin: string): RelayMessage {
  if (typeof value !== "object" || value === null)
    throw new Error("invalid message");
  const body = value as Record<string, unknown>;
  const to = body.to;
  if (typeof to !== "string" || to.length > 254 || !EMAIL.test(to))
    throw new Error("invalid recipient");
  if (body.kind === "reset")
    return { kind: "reset", to, url: link(body.url, origin, "/reset") };
  if (body.kind === "invite")
    return {
      kind: "invite",
      to,
      url: link(body.url, origin, "/invite"),
      inviterName: label(body.inviterName),
      target: label(body.target),
    };
  throw new Error("invalid kind");
}

function escape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function page(paragraphs: string[], action: string, url: string): string {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px">${escape(p)}</p>`)
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1f23"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px"><p style="margin:0 0 20px;font:15px ui-monospace,Menlo,monospace;color:#6b7280">palladian</p>${body}<p style="margin:24px 0"><a href="${escape(url)}" style="display:inline-block;background:#3b5bdb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escape(action)}</a></p><p style="margin:0;font-size:13px;color:#6b7280">If the button does not work, open this link:<br><span style="word-break:break-all">${escape(url)}</span></p></div></body></html>`;
}

/** Subject, plain text and HTML for one message. */
export function render(message: RelayMessage) {
  if (message.kind === "reset") {
    const lines = [
      "Someone asked to reset the password for your Palladian account.",
      "The link works once and expires in one hour. Resetting signs out your other devices.",
      "If you did not ask for this, ignore this email; your password stays the same.",
    ];
    return {
      subject: "Reset your Palladian password",
      text: `${lines.join("\n\n")}\n\nReset your password: ${message.url}\n`,
      html: page(lines, "Reset password", message.url),
    };
  }
  const who = message.inviterName ?? "Someone";
  const lines = message.target
    ? [
        `${who} invited you to “${message.target}” in Palladian.`,
        "Open the invitation to create your account. The link is just for you and expires in 14 days.",
      ]
    : [
        "You are invited to set up a Palladian account.",
        "Open the link to choose your password. The link is just for you and expires soon.",
      ];
  return {
    subject: message.target
      ? `${who} shared “${message.target}” with you`
      : "Set up your Palladian account",
    text: `${lines.join("\n\n")}\n\nOpen the invitation: ${message.url}\n`,
    html: page(lines, "Open invitation", message.url),
  };
}

export async function handleEmailRelay(
  request: Request,
  env: EmailEnv,
): Promise<Response> {
  if (request.method !== "POST") return status(405);
  if (!env.EMAIL || !env.EMAIL_FROM || !env.EMAIL_RELAY_SECRET)
    return status(503);
  const given = request.headers.get("Authorization") ?? "";
  if (!(await sameSecret(given, `Bearer ${env.EMAIL_RELAY_SECRET}`)))
    return status(401);
  const text = await request.text();
  if (text.length > MAX_BODY) return status(413);
  let message: RelayMessage;
  try {
    message = parseMessage(JSON.parse(text), env.PUBLIC_ORIGIN);
  } catch {
    return status(400);
  }
  const content = render(message);
  try {
    await env.EMAIL.send({
      from: { email: env.EMAIL_FROM, name: "Palladian" },
      to: message.to,
      ...content,
    });
  } catch (error) {
    // Never log the recipient, link or body.
    const code =
      error instanceof Error && "code" in error
        ? String(error.code)
        : "unknown";
    console.error("Account email failed", { kind: message.kind, code });
    return status(502);
  }
  return status(204);
}
