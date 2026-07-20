import test from 'node:test';
import assert from 'node:assert/strict';

import { Server } from '../js/index.ts';

let PORT = 20600;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('M6: CORS preflight is answered in Rust, WITHOUT waking JS', async () => {
  let jsWoken = false;
  const s = await up({
    config: { cors: { origin: '*' } },
    routes: (app) =>
      app.options('/x', () => {
        jsWoken = true; // must not run on preflight
        return 'js';
      }),
  });
  try {
    const res = await fetch(`${s.base}/x`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, authorization',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin')!, '*');
    assert.ok(res.headers.get('access-control-allow-methods')!.includes('POST'));
    // allowedHeaders unset → reflect the requested ones
    assert.equal(res.headers.get('access-control-allow-headers')!, 'content-type, authorization');
    assert.equal(jsWoken, false, 'JS must not wake up on preflight');
  } finally {
    s.close();
  }
});

test('M6: forbidden origin is rejected (403) on preflight', async () => {
  const s = await up({
    config: { cors: { origin: ['https://ok.com'] } },
    routes: (app) => app.post('/x', (c) => c.text('ok')),
  });
  try {
    const res = await fetch(`${s.base}/x`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin')!, null);
  } finally {
    s.close();
  }
});

test('M6: CORS headers on a regular response (allowed origin)', async () => {
  const s = await up({
    config: { cors: { origin: ['https://ok.com'], credentials: true, exposedHeaders: ['x-total'] } },
    routes: (app) => app.get('/data', (c) => c.json({ ok: true })),
  });
  try {
    const res = await fetch(`${s.base}/data`, { headers: { origin: 'https://ok.com' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin')!, 'https://ok.com');
    assert.equal(res.headers.get('access-control-allow-credentials')!, 'true');
    assert.equal(res.headers.get('access-control-expose-headers')!, 'x-total');
    assert.equal(res.headers.get('vary')!, 'origin');
  } finally {
    s.close();
  }
});

test('M6: a regular request from a foreign origin — no ACAO, but still served', async () => {
  const s = await up({
    config: { cors: { origin: ['https://ok.com'] } },
    routes: (app) => app.get('/data', (c) => c.text('served')),
  });
  try {
    const res = await fetch(`${s.base}/data`, { headers: { origin: 'https://evil.com' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'served'); // the server responds
    assert.equal(res.headers.get('access-control-allow-origin')!, null); // but without ACAO
  } finally {
    s.close();
  }
});

test('M6: credentials + origin=* is refused at construction', () => {
  // Honouring it means reflecting the caller's Origin, which lets any site send
  // credentialed requests and read the reply — the Same-Origin Policy stops applying.
  assert.throws(
    () => new Server({ cors: { origin: '*', credentials: true } }),
    /cannot be combined with credentials/,
  );
  // The same via an explicit list containing '*'.
  assert.throws(
    () => new Server({ cors: { origin: ['https://ok.com', '*'], credentials: true } }),
    /cannot be combined with credentials/,
  );
  // Without credentials '*' stays perfectly fine.
  assert.doesNotThrow(() => new Server({ cors: { origin: '*' } }));
});

test('M6: preflight with maxAge', async () => {
  const s = await up({
    config: { cors: { origin: '*', maxAge: 3600 } },
    routes: (app) => app.post('/x', (c) => c.text('ok')),
  });
  try {
    const res = await fetch(`${s.base}/x`, {
      method: 'OPTIONS',
      headers: { origin: 'https://a.com', 'access-control-request-method': 'POST' },
    });
    assert.equal(res.headers.get('access-control-max-age')!, '3600');
  } finally {
    s.close();
  }
});

test('M6: without a cors config there are no CORS headers', async () => {
  const s = await up({
    routes: (app) => app.get('/x', (c) => c.text('ok')),
  });
  try {
    const res = await fetch(`${s.base}/x`, { headers: { origin: 'https://a.com' } });
    assert.equal(res.headers.get('access-control-allow-origin')!, null);
  } finally {
    s.close();
  }
});

test('M6: native body-limit (confirmation) — 413 without cors', async () => {
  const s = await up({
    config: { bodyLimit: '1kb' },
    routes: (app) => app.post('/u', async (c) => c.text(await c.req.text())),
  });
  try {
    const res = await fetch(`${s.base}/u`, { method: 'POST', body: 'z'.repeat(5000) });
    assert.equal(res.status, 413);
  } finally {
    s.close();
  }
});
