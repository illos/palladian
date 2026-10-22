// Wrangler's local R2 simulation (Miniflare), for tests: a private,
// in-memory bucket per call. Nothing here reaches Cloudflare.
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";

const config = fileURLToPath(
  new URL("./fixtures/wrangler.r2.jsonc", import.meta.url),
);

export async function localR2() {
  const proxy = await getPlatformProxy({ configPath: config, persist: false });
  return { bucket: proxy.env.FILES, dispose: () => proxy.dispose() };
}
