export function requireFrontendOrigin(value: string | undefined): string {
  if (!value) throw new Error("Auth frontend origin configuration missing");
  const origin = new URL(value);
  if (
    origin.origin !== value ||
    origin.hostname.includes("*") ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost"))
  ) {
    throw new Error(
      "Auth requires an exact HTTPS frontend origin (localhost development allowed)",
    );
  }
  return value;
}

export function requireAuthSecret(value: string | undefined): string {
  if (!value || value.length < 32) {
    throw new Error(
      "Auth requires an explicitly configured secret of at least 32 characters",
    );
  }
  return value;
}
