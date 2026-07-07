import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { Server } from '../index.js';

// Свободный порт: слушаем на 0, узнаём номер — но naш listen(port) принимает
// конкретный порт, поэтому берём высокий и надеемся на свободность в CI.
// (Автовыбор порта появится на M10 через listen({port:0}).)
const PORT = 38080;

test('M1: сквозной путь сокет→Rust→JS→ответ', async () => {
  const server = new Server();

  server.listen(PORT, async (req) => {
    // async-хендлер: возвращаем Promise, мост его await-ит
    await new Promise((r) => setImmediate(r));
    return {
      status: 201,
      headers: { 'content-type': 'application/json', 'x-echo-path': req.path },
      body: JSON.stringify({ method: req.method, path: req.path, hi: 'from-js' }),
    };
  });

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/hello`);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('x-echo-path'), '/hello');

    const json = await res.json();
    assert.deepEqual(json, { method: 'GET', path: '/hello', hi: 'from-js' });
  } finally {
    server.close();
  }
});

test('M1: throw в хендлере → 500, процесс жив', async () => {
  const server = new Server();
  server.listen(PORT + 1, async () => {
    throw new Error('boom');
  });

  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 1}/`);
    assert.equal(res.status, 500);
  } finally {
    server.close();
  }
});

test('M1: close() идемпотентен и освобождает порт', async () => {
  const server = new Server();
  server.listen(PORT + 2, async () => ({ body: 'ok' }));
  server.close();
  server.close(); // второй раз — без ошибки

  // порт снова свободен → новый сервер поднимается
  const again = new Server();
  again.listen(PORT + 2, async () => ({ body: 'ok2' }));
  const res = await fetch(`http://127.0.0.1:${PORT + 2}/`);
  assert.equal(await res.text(), 'ok2');
  again.close();
});
