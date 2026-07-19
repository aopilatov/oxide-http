// Smoke-тест собранного пакета (M13). Специально на CommonJS без top-level await —
// должен работать на Node 18, то есть на нижней границе engines.
//
// Проверяет ровно то, что ломается при проблемах доставки: аддон грузится,
// сервер поднимается, запрос проходит, остановка отрабатывает.
const assert = require('node:assert/strict');
const { Server, HttpError } = require('../dist/index.js');

async function main() {
  assert.equal(typeof Server, 'function', 'Server должен экспортироваться');
  assert.equal(typeof HttpError, 'function', 'HttpError должен экспортироваться');

  const app = new Server();
  app.get('/health-check', (c) => c.json({ ok: true, node: process.versions.node }));
  app.post('/echo', async (c) => c.json(await c.req.json()));

  // Через реальный сокет — так же, как это сделает потребитель.
  await app.listen({ port: 0, host: '127.0.0.1' });

  const viaInject = await app.inject({ path: '/health-check' });
  assert.equal(viaInject.status, 200);
  assert.equal(viaInject.json().ok, true);

  const echo = await app.inject({ method: 'POST', path: '/echo', body: { привет: 'мир' } });
  assert.deepEqual(echo.json(), { привет: 'мир' });

  await app.close();

  console.log(`smoke ок: Node ${process.versions.node}, N-API ${process.versions.napi}`);
}

main().catch((err) => {
  console.error('smoke упал:', err);
  process.exit(1);
});
