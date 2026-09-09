import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
const servers = [5173,5176].map(port => createServer((_request, response) => { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><title>P0 CORS probe</title>'); }).listen(port, '127.0.0.1'));
await Promise.all(servers.map(server => new Promise((resolve,reject) => { server.once('listening',resolve); server.once('error',reject); })));
const browser = await chromium.launch({headless:true});
try {
  for (const [origin, expected] of [['http://localhost:5173', true], ['http://127.0.0.1:5176', false]]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Both blank frontend origins and Convex are actual loopback servers.
    await page.goto(origin + '/');
    const readable = await page.evaluate(async () => {
      try {
        const response = await fetch('http://127.0.0.1:3215/api/auth/get-session', {
          headers: {'Better-Auth-Cookie':''}, credentials:'omit',
        });
        return response.ok;
      } catch { return false; }
    });
    assert.equal(readable, expected, 'CORS request readability matches registered origin');
    console.log(`PASS Chromium real auth CORS: ${expected ? 'registered origin readable' : 'unregistered origin blocked'}`);
    await context.close();
  }
} finally { await browser.close(); await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
