/** A bucket from wrangler's local R2 simulation; see local-r2.mjs. */
export function localR2(): Promise<{
  bucket: R2Bucket;
  dispose: () => Promise<void>;
}>;
