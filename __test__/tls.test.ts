import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';

import { Server } from '../js/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CERT = readFileSync(join(here, 'fixtures/cert.pem'), 'utf8');
const KEY = readFileSync(join(here, 'fixtures/key.pem'), 'utf8');

// Порты намеренно ниже 32768: на Linux эфемерный диапазон начинается с 32768,
// и тест с listen({port:0}) мог получить от ядра ровно наш фиксированный порт.
// На macOS диапазон начинается с 49152, поэтому локально это не воспроизводилось.
let PORT = 20900;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config);
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, close: () => server.close() };
}

/** HTTP/2 клиент (TLS или h2c) → один GET. */
function h2get(url, opts = {}) {
  return new Promise<any>((resolve, reject) => {
    const client = http2.connect(url, opts);
    client.on('error', reject);
    const req = client.request({ ':path': '/' });
    let data = '';
    let headers;
    req.on('response', (h) => (headers = h));
    req.setEncoding('utf8');
    req.on('data', (d) => (data += d));
    req.on('end', () => {
      client.close();
      resolve({ status: headers[':status'], protocol: 'h2', body: data });
    });
    req.end();
  });
}

test('M9: TLS + ALPN → HTTP/2', async () => {
  const s = await up({
    config: { tls: { cert: CERT, key: KEY } },
    routes: (app) => app.get('/', (c) => c.json({ proto: 'via-alpn' })),
  });
  try {
    const res = await h2get(`https://127.0.0.1:${s.port}`, { ca: CERT });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { proto: 'via-alpn' });
  } finally {
    s.close();
  }
});

test('M9: TLS + HTTP/1.1 fallback', async () => {
  const s = await up({
    config: { tls: { cert: CERT, key: KEY } },
    routes: (app) => app.get('/', (c) => c.text('h1-over-tls')),
  });
  try {
    // alpnProtocol живёт на сокете, а не на IncomingMessage. Читаем его в
    // resolve-значение, а не ассертим внутри колбэка: throw там оборвал бы чтение
    // ответа и оставил TLS-сокет открытым (процесс теста не завершился бы).
    const { body, alpn } = await new Promise<any>((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port: s.port, path: '/', ca: CERT, ALPNProtocols: ['http/1.1'] } as any,
        (res: any) => {
          const alpn = (res.socket as any).alpnProtocol;
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve({ body: d, alpn }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(alpn, 'http/1.1');
    assert.equal(body, 'h1-over-tls');
  } finally {
    s.close();
  }
});

test('M9: h2c prior-knowledge (plaintext HTTP/2)', async () => {
  const s = await up({
    config: { h2c: true },
    routes: (app) => app.get('/', (c) => c.json({ h2c: true })),
  });
  try {
    const res = await h2get(`http://127.0.0.1:${s.port}`);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { h2c: true });
  } finally {
    s.close();
  }
});

test('M9: cert из Buffer грузится', async () => {
  const s = await up({
    config: { tls: { cert: Buffer.from(CERT), key: Buffer.from(KEY) } },
    routes: (app) => app.get('/', (c) => c.text('buf-ok')),
  });
  try {
    const body = await new Promise<any>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: s.port, path: '/', ca: CERT }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body, 'buf-ok');
  } finally {
    s.close();
  }
});

test('M9: Slowloris — медленные заголовки отсекаются таймаутом', async () => {
  const s = await up({
    config: { headerReadTimeout: '200ms' },
    routes: (app) => app.get('/', (c) => c.text('ok')),
  });
  try {
    const closed = await new Promise<any>((resolve) => {
      const socket = net.connect(s.port, '127.0.0.1');
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          socket.destroy();
          resolve(v);
        }
      };
      socket.on('connect', () => {
        // Шлём начало запроса и НЕ завершаем заголовки.
        socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
        // не пишем финальный \r\n — сервер должен закрыть по таймауту
      });
      socket.on('close', () => finish('closed'));
      socket.on('end', () => finish('closed'));
      setTimeout(() => finish('still-open'), 1500);
    });
    assert.equal(closed, 'closed', 'соединение должно закрыться по headerReadTimeout');
  } finally {
    s.close();
  }
});

test('M9: HTTP/2 с настройками (maxConcurrentStreams, initialWindowSize)', async () => {
  const s = await up({
    config: {
      h2c: true,
      http2: { maxConcurrentStreams: 100, initialWindowSize: '1mb', maxResetStreamsPerSec: 50 },
    },
    routes: (app) => app.get('/', (c) => c.text('tuned')),
  });
  try {
    const res = await h2get(`http://127.0.0.1:${s.port}`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'tuned');
  } finally {
    s.close();
  }
});

/** Сырой HTTP/1.1-запрос по сокету; резолвится сырым ответом (или '' при обрыве).
 *  `write(socket, stop)` — писатель; `stop()` возвращает true, когда ответ уже пришёл
 *  и продолжать писать не нужно (иначе close с непрочитанными данными даёт RST). */
function raw(port, write, waitMs = 3000) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(data);
    };
    socket.on('connect', () => write(socket, () => data.length > 0));
    socket.on('data', (d) => (data += d));
    socket.on('close', finish);
    socket.on('error', (e) => (done ? null : (done = true), reject(e)));
    setTimeout(finish, waitMs);
  });
}

test('M9: maxHeaderSize превышен → 431', async () => {
  const s = await up({
    config: { maxHeaderSize: '8kb' },
    routes: (app) => app.get('/', (c) => c.text('ok')),
  });
  try {
    // Пишем заголовок кусками и останавливаемся, как только пришёл ответ: hyper
    // отвечает 431 и закрывает соединение, а недописанный «хвост» превратил бы
    // close в RST — клиент потерял бы уже полученный ответ (ECONNRESET).
    const res = await raw(s.port, (sock, stop) => {
      sock.write('GET / HTTP/1.1\r\nHost: x\r\nX-Big: ');
      let sent = 0;
      const pump = () => {
        if (stop() || sent++ >= 32) return;
        sock.write('x'.repeat(1024), () => setTimeout(pump, 5));
      };
      pump();
    });
    assert.match(res, /^HTTP\/1\.1 431 /, `ожидался 431, получено: ${res.slice(0, 60)}`);
  } finally {
    s.close();
  }
});

test('M9: bodyReadTimeout — молчание в середине тела → 408', async () => {
  const s = await up({
    config: { bodyReadTimeout: '300ms' },
    routes: (app) => app.post('/', async (c) => c.text(await c.req.text())),
  });
  try {
    // Заявляем 100 байт, шлём 5 и замолкаем — сервер не должен ждать вечно.
    const res = await raw(s.port, (sock) => {
      sock.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nhello');
    });
    assert.match(res, /^HTTP\/1\.1 408 /, `ожидался 408, получено: ${res.slice(0, 60)}`);
  } finally {
    s.close();
  }
});

test('M9: idleTimeout закрывает простаивающий keep-alive', async () => {
  const s = await up({
    config: { idleTimeout: '400ms' },
    routes: (app) => app.get('/', (c) => c.text('ok')),
  });
  try {
    const t0 = Date.now();
    // Один нормальный запрос, дальше молчим — соединение должно закрыться сервером.
    const res = await raw(
      s.port,
      (sock) => sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'),
      3000,
    );
    const elapsed = Date.now() - t0;
    assert.match(res, /^HTTP\/1\.1 200 /);
    assert.ok(elapsed < 2000, `соединение должно закрыться по idleTimeout, прошло ${elapsed}ms`);
  } finally {
    s.close();
  }
});

test('M9: idleTimeout не рвёт долгий запрос (in-flight не простой)', async () => {
  const s = await up({
    config: { idleTimeout: '300ms' },
    routes: (app) =>
      app.get('/slow', async (c) => {
        // Хендлер думает дольше idleTimeout и ничего не пишет в сокет.
        await new Promise<void>((r) => setTimeout(r, 900));
        return c.text('slow-ok');
      }),
  });
  try {
    const res = await raw(s.port, (sock) => sock.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n'));
    assert.match(res, /^HTTP\/1\.1 200 /, `запрос не должен обрываться: ${res.slice(0, 60)}`);
    assert.match(res, /slow-ok/);
  } finally {
    s.close();
  }
});
