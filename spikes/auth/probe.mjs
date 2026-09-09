import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { api } from './convex/_generated/api.js';

const base = 'http://127.0.0.1:3215/api/auth';
const origin = 'http://localhost:5173';
const password = randomBytes(24).toString('base64url');
const email = `fixture-${randomBytes(8).toString('hex')}@example.invalid`;
function jar() {
  const cookies = new Map();
  return {
    async call(path, body, requestOrigin = origin) {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: requestOrigin, 'Content-Type': 'application/json',
          'Better-Auth-Cookie': [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const header = response.headers.get('set-better-auth-cookie');
      if (header) for (const part of header.split(/,(?=\s*[^;,=]+=[^;,]*)/)) {
        const pair = part.trim().split(';')[0]; const split = pair.indexOf('=');
        cookies.set(pair.slice(0,split), pair.slice(split+1));
      }
      let data; try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data, response };
    },
  };
}
function check(condition, message) { assert.ok(condition, message); console.log(`PASS ${message}`); }
try {
  const a = jar(); const b = jar();
  const signup = await a.call('/sign-up/email', {email,password,name:'Fixture'});
  check(signup.status === 200, `fixture signup HTTP ${signup.status}`);
  check((await b.call('/sign-in/email', {email,password})).status === 200, 'independent second session');
  const session = await a.call('/get-session');
  check(session.status === 200 && session.data?.session, 'persisted credential recovers session');
  const ttl = new Date(session.data.session.expiresAt) - new Date(session.data.session.createdAt);
  check(Math.abs(ttl - 365*86400_000) < 1000, '365-day session lifetime configured');
  const demands = await Promise.all(Array.from({length:8},() => a.call('/convex/token')));
  check(demands.every(r => r.status === 200 && typeof r.data?.token === 'string'), 'eight concurrent JWT demands');
  const jwt = demands[0].data.token;
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  check(payload.exp - payload.iat === 900, 'JWT lifetime independently 900 seconds');
  const client = new ConvexHttpClient('http://127.0.0.1:3214'); client.setAuth(jwt);
  check(await client.query(api.auth.protectedProbe, {}), 'actual Convex verifies JWT and live session');
  await a.call('/convex/token'); // Deliberately discard a successful token response.
  check((await a.call('/convex/token')).status === 200, 'retry after discarded successful token response');
  const revoked = await b.call('/revoke-session', {token:session.data.session.token});
  check(revoked.status === 200, 'second session revokes first session');
  check(payload.exp > Date.now()/1000, 'revocation check uses still-unexpired JWT');
  let denied = false; try { await client.query(api.auth.protectedProbe, {}); } catch (error) { denied = error instanceof ConvexError && error.data === 'Unauthenticated'; }
  check(denied, 'revoked session rejected with previously valid unexpired JWT');
  check((await b.call('/convex/token')).status === 200, 'other device session remains valid');
  check(!(await a.call('/get-session')).data?.session, 'revoked credential cannot recover session');
  const hostile = await b.call('/sign-out', {}, 'https://untrusted.example');
  console.log(`OBSERVED custom credential header sign-out from untrusted Origin HTTP ${hostile.status}; browser CORS/CSRF acceptance remains pending review`);
  check((await b.call('/sign-out', {})).status === 200, 'remaining fixture session signs out');
  console.log('Actual loopback services; Node HTTP clients; no browser, mocks, cloud, or iPhone evidence.');
} catch (error) {
  // Never print HTTP response bodies, headers, JWTs, or fixture credentials.
  console.error(error instanceof assert.AssertionError ? error.message : 'Auth probe failed (details suppressed to protect credentials)');
  process.exitCode = 1;
}
