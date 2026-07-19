// Smoke test for the built package (M13). Deliberately CommonJS without top-level
// await — it must run on Node 18, the lower bound of our engines range.
//
// It checks exactly what breaks when delivery goes wrong: the addon loads, the server
// starts, a request goes through, and shutdown works.
const assert = require('node:assert/strict');
const { Server, HttpError } = require('../dist/index.js');

async function main() {
  assert.equal(typeof Server, 'function', 'Server must be exported');
  assert.equal(typeof HttpError, 'function', 'HttpError must be exported');

  const app = new Server();
  app.get('/health-check', (c) => c.json({ ok: true, node: process.versions.node }));
  app.post('/echo', async (c) => c.json(await c.req.json()));

  // Over a real socket — exactly what a consumer will do.
  await app.listen({ port: 0, host: '127.0.0.1' });

  const viaInject = await app.inject({ path: '/health-check' });
  assert.equal(viaInject.status, 200);
  assert.equal(viaInject.json().ok, true);

  const echo = await app.inject({ method: 'POST', path: '/echo', body: { hello: 'world' } });
  assert.deepEqual(echo.json(), { hello: 'world' });

  await app.close();

  console.log(`smoke ok: Node ${process.versions.node}, N-API ${process.versions.napi}`);
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
