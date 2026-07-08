import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as v from 'valibot';

const require = createRequire(import.meta.url);
const { Server } = require('../js/index.js');

let PORT = 38700;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('M7: невалидное тело → 400 без пробуждения JS', async () => {
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
      body: JSON.stringify({ name: 'x', age: -5 }), // name слишком короткий, age < 0
    });
    assert.equal(res.status, 400);
    assert.equal(handlerCalled, false, 'хендлер не должен просыпаться на невалидном теле');
    const body = await res.json();
    assert.equal(body.error, 'validation');
    assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
    assert.ok(body.issues.every((i) => i.path && i.message && i.code));
  } finally {
    s.close();
  }
});

test('M7: валидное тело проходит; c.req.valid("body")', async () => {
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

test('M7: коэрция query (?age=42 → number)', async () => {
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
    // невалидный тип → 400
    const bad = await fetch(`${s.base}/q?age=notnum`);
    assert.equal(bad.status, 400);
  } finally {
    s.close();
  }
});

test('M7: valibot transform применяется (preValidation)', async () => {
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
    assert.deepEqual(await res.json(), { name: 'BOB' }); // transform сработал
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

test('M7: response стрип — лишние поля не утекают', async () => {
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
    assert.deepEqual(body, { id: 1, name: 'Bob' }); // password/ssn отсечены
  } finally {
    s.close();
  }
});

test('M7: сырой JSON Schema тоже работает', async () => {
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

test('M7: params-валидация', async () => {
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
