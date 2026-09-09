import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('.', import.meta.url));
const config = readFileSync(new URL('.env.local', import.meta.url), 'utf8');
const values = Object.fromEntries(config.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1).trim()];
}));
if (process.env.CONVEX_DEPLOY_KEY || process.env.CONVEX_DEPLOYMENT || process.env.CONVEX_SELF_HOSTED_URL ||
    !values.CONVEX_DEPLOYMENT?.startsWith('anonymous:') ||
    values.CONVEX_URL !== 'http://127.0.0.1:3214' || values.CONVEX_SITE_URL !== 'http://127.0.0.1:3215') {
  throw new Error('Refusing secret setup: expected anonymous local 3214/3215 deployment without environment overrides');
}
console.log('target: local-anonymous (loopback 3214/3215); setting fixture-only secret');
const result = spawnSync('../../node_modules/.bin/convex', ['env', 'set', 'BETTER_AUTH_SECRET', randomBytes(48).toString('base64url')], {
  cwd, env: {...process.env, CONVEX_AGENT_MODE: 'anonymous'}, stdio: 'pipe',
});
// The CLI may echo arguments on failure. Suppress all of its output.
console.log(result.status === 0 ? 'Fixture secret set; value suppressed.' : 'Fixture secret setup failed; CLI output suppressed.');
process.exitCode = result.status ?? 1;
