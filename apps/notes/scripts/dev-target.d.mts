import type { Browser } from "@playwright/test";

export interface DevTarget {
  /** The deployment name, for example "decisive-reindeer-520". */
  name: string;
  /** "dev:<name>". */
  deployment: string;
  /** https://<name>.convex.site */
  site: string;
  /** https://<name>.convex.cloud */
  cloud: string;
}

/** Variables that would point the Convex CLI at another deployment or host. */
export const OVERRIDES: readonly string[];
/** A dotenv file's variables. */
export function parseEnvFile(text: string): Record<string, string>;
/** The one development deployment everything must use; throws otherwise. */
export function devTarget(
  env: Record<string, string | undefined>,
  files?: Record<string, Record<string, string>>,
): DevTarget;
/** The backend directory's .env.local and .env, as the Convex CLI reads them. */
export function readEnvFiles(
  backendDir: string,
): Record<string, Record<string, string>>;
/** The deployment the Convex CLI acts on from `backendDir`, or null. */
export function cliDeployment(
  backendDir: string,
  env: Record<string, string | undefined>,
): string | null;
/** The Convex hosts the app at `appUrl` talks to. */
export function appEndpoints(
  browser: Browser,
  appUrl: string,
  target: DevTarget,
  timeout?: number,
): Promise<string[]>;
/** Every check, before anything is provisioned. */
export function assertDevTarget(options: {
  env: Record<string, string | undefined>;
  backendDir: string;
  browser: Browser;
  appUrl: string;
}): Promise<DevTarget>;
