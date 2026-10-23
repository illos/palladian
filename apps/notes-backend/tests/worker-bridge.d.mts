/** The Worker's `storeObject`, typed for backend tests; see worker-bridge.mjs. */
export interface BridgeBucket {
  put(key: string, value: Uint8Array, options?: unknown): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<unknown>;
}
export interface BridgeCaller {
  query(fn: unknown, args: unknown): Promise<unknown>;
  mutation(fn: unknown, args: unknown): Promise<unknown>;
}
export type StoreResult =
  { ok: true; size: number; sha256: string } | { ok: false; error: string };
export function storeObject(
  env: {
    FILES: BridgeBucket;
    CONVEX_URL: string;
    AGENT_JWT_PRIVATE_KEY: string;
    AGENT_JWT_ISSUER: string;
  },
  objectId: string,
  ticket: string,
  read: (max: number) => Promise<Uint8Array | null>,
  deps: { service: () => Promise<BridgeCaller> },
): Promise<StoreResult>;
