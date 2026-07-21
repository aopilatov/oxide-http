// The HTTP QUERY method (draft-ietf-httpbis-safe-method-w-body): a safe method whose
// request body describes the query. Registered via app.query(); the body works exactly
// like a POST body (streaming, schemas, limits).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Server } from '../js/index.ts';

let PORT = 21900;
const nextPort = () => PORT++;

async function up(build: {
  config?: ConstructorParameters<typeof Server>[0];
  routes?: (app: Server) => void;
}) {
  const server = new Server(build.config ?? {});
  build.routes?.(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, server, close: () => server.close() };
}

/** fetch() refuses non-standard methods in some undici versions — use raw http. */
function queryRequest(
  port: number,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'QUERY', headers },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => (data += c.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body != null) req.setHeader('content-type', 'application/json');
    req.end(body);
  });
}

test('QUERY: app.query() routes and the body reaches the handler', async () => {
  const s = await up({
    routes: (app) =>
      app.query('/search', async (c) => {
        const q = await c.req.json<{ term: string }>();
        return { found: q.term.toUpperCase() };
      }),
  });
  try {
    const res = await queryRequest(s.port, '/search', JSON.stringify({ term: 'abc' }));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { found: 'ABC' });
  } finally {
    await s.close();
  }
});

test('QUERY: 405 Allow includes QUERY when only QUERY is registered', async () => {
  const s = await up({ routes: (app) => app.query('/only-query', (c) => c.text('q')) });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/only-query`, { method: 'POST' });
    assert.equal(res.status, 405);
    const allow = res.headers.get('allow') ?? '';
    assert.ok(allow.includes('QUERY'), `Allow must include QUERY, got: ${allow}`);
  } finally {
    await s.close();
  }
});

test('QUERY: schema.body is validated natively (400 without waking JS)', async () => {
  let jsWoken = false;
  const s = await up({
    routes: (app) =>
      app.query(
        '/typed',
        {
          schema: {
            body: {
              type: 'object',
              properties: { limit: { type: 'number' } },
              required: ['limit'],
            },
          },
        },
        (c) => {
          jsWoken = true;
          return c.json(c.req.valid('body'));
        },
      ),
  });
  try {
    const bad = await queryRequest(s.port, '/typed', JSON.stringify({ limit: 'nope' }));
    assert.equal(bad.status, 400);
    assert.equal(jsWoken, false, 'a schema rejection must not wake JS');

    const ok = await queryRequest(s.port, '/typed', JSON.stringify({ limit: 5 }));
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { limit: 5 });
  } finally {
    await s.close();
  }
});

test('QUERY: a QUERY request never falls into a GET route', async () => {
  const s = await up({ routes: (app) => app.get('/g', (c) => c.text('get')) });
  try {
    const res = await queryRequest(s.port, '/g');
    assert.equal(res.status, 405);
  } finally {
    await s.close();
  }
});

test('QUERY: ALL routes accept it', async () => {
  const s = await up({ routes: (app) => app.all('/any', (c) => c.text(c.req.method)) });
  try {
    const res = await queryRequest(s.port, '/any');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'QUERY');
  } finally {
    await s.close();
  }
});

test('QUERY: auto-OPTIONS advertises QUERY in Allow', async () => {
  const s = await up({ routes: (app) => app.query('/only-query', (c) => c.text('q')) });
  try {
    const opt = await fetch(`http://127.0.0.1:${s.port}/only-query`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
    assert.ok((opt.headers.get('allow') ?? '').includes('QUERY'));
  } finally {
    await s.close();
  }
});
