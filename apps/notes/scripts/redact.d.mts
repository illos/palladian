/** Registers a value (a password, an invitation token) that must never print. */
export function secret<T>(value: T): T;
/** Forgets registered values (for tests). */
export function forgetSecrets(): void;
/** The text with secrets, credentials and URL queries and fragments removed. */
export function redact(value: unknown): string;
/** A failure reduced to what is safe to print: its kind and a short message. */
export function describeFailure(failure: unknown, lines?: number): string;
