// Серверы-участники бенчмарка, каждый поднимается в СВОЁМ процессе (§17).
// Так генератор нагрузки не конкурирует с сервером за event loop — иначе
// у @oxide/http JS-хендлер дерётся за главный поток с самим клиентом.
//
// Запуск: node bench/servers.mjs <target> <port>
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const target = process.argv[2];
const port = Number(process.argv[3]);
const PAYLOAD = { hello: 'world', ok: true, n: 42 };

const starters = {
  async 'oxide'() {
    const { Server } = require(join(here, '../js/index.js'));
    const app = new Server();
    app.get('/json', (c) => c.json(PAYLOAD));
    app.get('/text', (c) => c.text('ok'));
    await app.listen({ port, host: '127.0.0.1' });
  },

  // Нативная ручка: отвечает целиком в Rust, JS не будится. Показывает цену
  // самого моста — разницу между этой строкой и /json.
  async 'oxide-native'() {
    const { Server } = require(join(here, '../js/index.js'));
    const app = new Server({ health: { path: '/json' } });
    app.get('/text', (c) => c.text('ok'));
    await app.listen({ port, host: '127.0.0.1' });
  },

  async 'node-http'() {
    const body = JSON.stringify(PAYLOAD);
    const srv = http.createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      } else if (req.url === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  },

  async 'fastify'() {
    const Fastify = (await import('fastify')).default;
    const app = Fastify({ logger: false });
    app.get('/json', () => PAYLOAD);
    app.get('/text', (_req, reply) => reply.type('text/plain').send('ok'));
    await app.listen({ port, host: '127.0.0.1' });
  },

  async 'hono'() {
    const { Hono } = await import('hono');
    const { serve } = await import('@hono/node-server');
    const app = new Hono();
    app.get('/json', (c) => c.json(PAYLOAD));
    app.get('/text', (c) => c.text('ok'));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  },
};

const start = starters[target];
if (!start) {
  console.error(`неизвестный участник: ${target}`);
  process.exit(2);
}
await start();
console.log('ready');
