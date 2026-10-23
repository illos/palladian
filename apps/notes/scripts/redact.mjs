// What real-service scripts may print. Every message, error and debug line
// goes through `redact` first: URLs lose their query and fragment (invitation
// and reset links carry their tokens there) and long opaque path segments,
// JWTs and bearer credentials are hidden, `password=`/`token:`-style values
// are hidden, and any value registered with `secret` is replaced wherever it
// appears. Shared by the notes e2e scripts.

const secrets = new Set();

/** Registers a value (a password, an invitation token) that must never print. */
export function secret(value) {
  if (typeof value === "string" && value.length >= 6) secrets.add(value);
  return value;
}

/** Forgets registered values (for tests). */
export function forgetSecrets() {
  secrets.clear();
}

/**
 * A URL as written, up to its query or fragment, with any credentials and long
 * opaque path segments (tokens, IDs) hidden.
 */
function safeUrl(url) {
  const cut = url.search(/[?#]/);
  const base = (cut < 0 ? url : url.slice(0, cut))
    .replace(/\/\/[^/@]*@/, "//[…]@")
    .replace(/\/[A-Za-z0-9_-]{20,}(?=\/|$)/g, "/[id]");
  return base + (cut < 0 ? "" : "[…]");
}

/** The text with secrets, credentials and URL queries and fragments removed. */
export function redact(value) {
  let text =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === "string"
        ? value
        : String(value);
  for (const known of secrets) text = text.split(known).join("[secret]");
  return (
    text
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()]+/gi, (url) => {
        // Sentence punctuation after a URL is not part of it.
        const end = /[.,;:!?]+$/.exec(url)?.[0] ?? "";
        return safeUrl(url.slice(0, url.length - end.length)) + end;
      })
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[token]")
      .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, "$1 [secret]")
      .replace(
        /((?:password|passwd|token|secret|cookie|authorization|api[_-]?key|deploy[_-]?key|admin[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
        "$1[secret]",
      )
      // A fragment or query left without its URL (for example "#token").
      .replace(/[#?][A-Za-z0-9_.~%+/=-]{12,}/g, "[…]")
  );
}

/** A failure reduced to what is safe to print: its kind and a short message. */
export function describeFailure(failure, lines = 8) {
  const name =
    failure instanceof Error ? failure.name || "Error" : typeof failure;
  const message =
    failure instanceof Error ? failure.message : String(failure ?? "");
  return `${name}: ${redact(message).split("\n").slice(0, lines).join("\n")}`;
}
