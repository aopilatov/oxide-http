import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { Server } from '../js/index.ts';

let PORT = 38400;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Сырой HTTP-запрос через TCP (fetch не даёт слать «кривые» тела). */
function rawRequest(
  port: number,
  requestText: string,
  { bodyChunks = [], settleMs = 300 }: { bodyChunks?: string[]; settleMs?: number } = {},
) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => (data += d));
    // Соединение может быть сброшено (мусор после тела / Connection: close) —
    // это не ошибка теста: ответ на первый запрос уже пришёл. Игнорируем.
    socket.on('error', () => {});
    socket.on('connect', async () => {
      socket.write(requestText);
      for (const ch of bodyChunks) {
        socket.write(ch);
        await new Promise<void>((r) => setTimeout(r, 10));
      }
    });
    setTimeout(() => {
      socket.destroy();
      const statusLine = data.split('\r\n')[0] || '';
      const m = statusLine.match(/HTTP\/1\.[01] (\d{3})/);
      resolve({ status: m ? Number(m[1]) : 0, raw: data });
    }, settleMs);
  });
}

test('SECURITY: лимит держится на СЫРОМ стриме (хендлер не проверяет размер)', async () => {
  // Хендлер просто гоняет c.req.stream, НЕ проверяя размер сам — лимит обязан
  // сработать в Rust, иначе DoS. bodyLimit 1kb, шлём ~10kb.
  let received = 0;
  const s = await up({
    config: { bodyLimit: '1kb' },
    routes: (app) =>
      app.post('/raw', async (c) => {
        for await (const chunk of c.req.stream) received += chunk.length;
        return c.text('ok');
      }),
  });
  try {
    const res = await fetch(`${s.base}/raw`, { method: 'POST', body: 'A'.repeat(10 * 1024) });
    assert.equal(res.status, 413, 'сырой стрим должен упереться в лимит');
    assert.ok(received <= 1024 + 65536, `Rust прочитал слишком много: ${received} байт`);
  } finally {
    s.close();
  }
});

test('SECURITY: лимит держится на chunked БЕЗ Content-Length', async () => {
  // Transfer-Encoding: chunked — Content-Length нет вовсе. Лимит должен считать
  // фактические байты. Шлём много мелких чанков через сырой сокет.
  const s = await up({
    config: { bodyLimit: '2kb' },
    routes: (app) => app.post('/chunked', async (c) => c.text(await c.req.text())),
  });
  try {
    // 20 chunk'ов по 512 байт = 10kb > 2kb.
    const chunks = [] as any[];
    for (let i = 0; i < 20; i++) {
      chunks.push(`200\r\n${'B'.repeat(512)}\r\n`);
    }
    chunks.push('0\r\n\r\n');
    const req =
      `POST /chunked HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`;
    const res = await rawRequest(s.port, req, { bodyChunks: chunks });
    assert.equal(res.status, 413, 'chunked без CL должен упереться в лимит');
  } finally {
    s.close();
  }
});

test('SECURITY: ранний 413 по заявленному Content-Length (тело не читается)', async () => {
  let handlerCalled = false;
  const s = await up({
    config: { bodyLimit: '1kb' },
    routes: (app) =>
      app.post('/big', async (c) => {
        handlerCalled = true;
        return c.text('ok');
      }),
  });
  try {
    // Заявляем большой Content-Length — отказ должен прийти сразу.
    const req =
      `POST /big HTTP/1.1\r\nHost: x\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n`;
    const res = await rawRequest(s.port, req, { settleMs: 200 });
    assert.equal(res.status, 413);
    assert.equal(handlerCalled, false, 'хендлер не должен вызываться при раннем 413');
  } finally {
    s.close();
  }
});

test('SECURITY: Content-Length врёт МЕНЬШЕ — hyper фреймит по CL, лишнее не течёт в тело', async () => {
  // Заявляем CL=5, шлём больше. hyper отдаст ровно 5 байт; хвост — уже следующий
  // (pipelined) запрос, а не часть тела. Лимит не обходится.
  const s = await up({
    config: { bodyLimit: '1mb' },
    routes: (app) => app.post('/cl', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const req =
      `POST /cl HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nConnection: close\r\n\r\nHELLO` +
      'X'.repeat(10000); // лишние байты после тела
    const res = await rawRequest(s.port, req, { settleMs: 200 });
    assert.equal(res.status, 200);
    assert.match(res.raw, /"len":5/, 'тело должно быть ровно 5 байт (CL), лишнее не подмешалось');
  } finally {
    s.close();
  }
});

test('SECURITY: без лимита (bodyLimit не задан) большое тело всё же читается', async () => {
  // Санити: если лимит явно не задан низким — работает как обычно (дефолт 10mb).
  const s = await up({
    routes: (app) => app.post('/ok', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const res = await fetch(`${s.base}/ok`, { method: 'POST', body: 'y'.repeat(100 * 1024) });
    assert.deepEqual(await res.json(), { len: 100 * 1024 });
  } finally {
    s.close();
  }
});
