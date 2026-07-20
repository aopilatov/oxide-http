import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import * as v from 'valibot';

import { Server } from '../js/index.ts';

let PORT = 20700;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('B1: a compressed body is validated, not rejected', async () => {
  // The regression: a compressed body skipped Rust buffering, so the validator saw
  // "no body" and answered 400 — a valid gzipped request could never reach the handler.
  const User = v.object({ name: v.string(), age: v.number() });
  const s = await up({
    routes: (app) =>
      app.post('/users', { schema: { body: User } }, (c) => c.json(c.req.valid('body'))),
  });
  try {
    const payload = JSON.stringify({ name: 'Bob', age: 42 });
    const encodings = {
      gzip: gzipSync(payload),
      deflate: deflateSync(payload),
      br: brotliCompressSync(payload),
    };
    for (const [encoding, body] of Object.entries(encodings)) {
      const res = await fetch(`${s.base}/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': encoding },
        body,
      });
      assert.equal(res.status, 200, `${encoding} should be accepted`);
      assert.deepEqual(await res.json(), { name: 'Bob', age: 42 }, `${encoding} payload`);
    }

    // The schema still applies to the decoded document.
    const bad = await fetch(`${s.base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: gzipSync(JSON.stringify({ name: 'Bob', age: 'not a number' })),
    });
    assert.equal(bad.status, 400);
  } finally {
    s.close();
  }
});

test('B1: a broken or unknown encoding is a client error', async () => {
  const User = v.object({ name: v.string() });
  const s = await up({
    routes: (app) =>
      app.post('/users', { schema: { body: User } }, (c) => c.json(c.req.valid('body'))),
  });
  try {
    const notGzip = await fetch(`${s.base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: 'this is not gzip at all',
    });
    assert.equal(notGzip.status, 400);

    const unknown = await fetch(`${s.base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'lzma' },
      body: gzipSync('{"name":"Bob"}'),
    });
    assert.equal(unknown.status, 415);
  } finally {
    s.close();
  }
});

test('B1: a zip bomb is stopped at bodyLimit', async () => {
  const User = v.object({ name: v.string() });
  const s = await up({
    config: { bodyLimit: '8kb' },
    routes: (app) =>
      app.post('/users', { schema: { body: User } }, (c) => c.json(c.req.valid('body'))),
  });
  try {
    // Compresses to well under 8kb but expands to 4 MiB — the limit applies to the
    // decoded size, so this must never be materialised.
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x41));
    assert.ok(bomb.length < 8 * 1024, `bomb should be small: ${bomb.length}`);
    const res = await fetch(`${s.base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: bomb,
    });
    assert.equal(res.status, 413);
  } finally {
    s.close();
  }
});

test('B1: schema.body on a multipart route fails listen()', async () => {
  // A multipart body is a stream of parts, so the schema could never match and every
  // request would 400. Better to say so at startup.
  const app = new Server();
  app.post(
    '/upload',
    { multipart: true, schema: { body: v.object({ name: v.string() }) } },
    (c) => c.text('ok'),
  );
  await assert.rejects(
    () => app.listen({ port: nextPort(), host: '127.0.0.1' }),
    /schema\.body is not supported on a multipart route/,
  );
});

test('M7: invalid body → 400 without waking JS', async () => {
  let handlerCalled = false;
  const CreateUser = v.object({
    name: v.pipe(v.string(), v.minLength(2)),
    age: v.pipe(v.number(), v.minValue(0)),
  });
  const s = await up({
    routes: (app) =>
      app.post('/users', { schema: { body: CreateUser } }, (c) => {
        handlerCalled = true;
        return c.json(c.req.valid('body'));
      }),
  });
  try {
    const res = await fetch(`${s.base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', age: -5 }), // name too short, age < 0
    });
    assert.equal(res.status, 400);
    assert.equal(handlerCalled, false, 'the handler must not wake up on an invalid body');
    const body = await res.json();
    assert.equal(body.error, 'validation');
    assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
    assert.ok(body.issues.every((i) => i.path && i.message && i.code));
  } finally {
    s.close();
  }
});

test('M7: a valid body passes; c.req.valid("body")', async () => {
  const CreateUser = v.object({ name: v.string(), age: v.number() });
  const s = await up({
    routes: (app) =>
      app.post('/users', { schema: { body: CreateUser } }, (c) => c.json(c.req.valid('body'))),
  });
  try {
    const res = await fetch(`${s.base}/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', age: 30 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: 'Bob', age: 30 });
  } finally {
    s.close();
  }
});

test('M7: query coercion (?age=42 → number)', async () => {
  const Query = v.object({ age: v.number(), ref: v.optional(v.string()) });
  const s = await up({
    routes: (app) =>
      app.get('/q', { schema: { query: Query } }, (c) => {
        const q = c.req.valid('query');
        return c.json({ age: q.age, isNumber: typeof q.age === 'number' });
      }),
  });
  try {
    const res = await fetch(`${s.base}/q?age=42`);
    assert.deepEqual(await res.json(), { age: 42, isNumber: true });
    // invalid type → 400
    const bad = await fetch(`${s.base}/q?age=notnum`);
    assert.equal(bad.status, 400);
  } finally {
    s.close();
  }
});

test('M7: the valibot transform is applied (preValidation)', async () => {
  const Body = v.object({
    name: v.pipe(v.string(), v.transform((s) => s.toUpperCase())),
  });
  const s = await up({
    routes: (app) =>
      app.post('/t', { schema: { body: Body } }, (c) => c.json(c.req.valid('body'))),
  });
  try {
    const res = await fetch(`${s.base}/t`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bob' }),
    });
    assert.deepEqual(await res.json(), { name: 'BOB' }); // the transform ran
  } finally {
    s.close();
  }
});

test('M7: valibot refine (check) → 400', async () => {
  const Body = v.object({
    password: v.pipe(v.string(), v.check((s) => s.length >= 8, 'too short')),
  });
  const s = await up({
    routes: (app) => app.post('/p', { schema: { body: Body } }, (c) => c.json({ ok: true })),
  });
  try {
    const res = await fetch(`${s.base}/p`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'short' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.issues.some((i) => /short/.test(i.message)));
  } finally {
    s.close();
  }
});

test('M7: response stripping — extra fields do not leak', async () => {
  const UserOut = v.object({ id: v.number(), name: v.string() });
  const s = await up({
    routes: (app) =>
      app.get('/me', { schema: { response: { 200: UserOut } } }, (c) =>
        c.json({ id: 1, name: 'Bob', password: 'SECRET', ssn: '123' }),
      ),
  });
  try {
    const res = await fetch(`${s.base}/me`);
    const body = await res.json();
    assert.deepEqual(body, { id: 1, name: 'Bob' }); // password/ssn stripped
  } finally {
    s.close();
  }
});

test('M7: raw JSON Schema works too', async () => {
  const schema = {
    type: 'object',
    properties: { email: { type: 'string' } },
    required: ['email'],
  };
  const s = await up({
    routes: (app) =>
      app.post('/j', { schema: { body: schema } }, (c) => c.json(c.req.valid('body'))),
  });
  try {
    const ok = await fetch(`${s.base}/j`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${s.base}/j`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
  } finally {
    s.close();
  }
});

test('M7: params validation', async () => {
  const Params = v.object({ id: v.pipe(v.number(), v.integer()) });
  const s = await up({
    routes: (app) =>
      app.get('/u/:id', { schema: { params: Params } }, (c) => {
        const p = c.req.valid('params');
        return c.json({ id: p.id, t: typeof p.id });
      }),
  });
  try {
    assert.deepEqual(await (await fetch(`${s.base}/u/7`)).json(), { id: 7, t: 'number' });
    assert.equal((await fetch(`${s.base}/u/abc`)).status, 400);
  } finally {
    s.close();
  }
});
