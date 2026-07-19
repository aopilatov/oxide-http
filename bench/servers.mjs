// Benchmark participants, each started in its OWN process (§17).
// That way the load generator does not compete with the server for the event loop —
// otherwise the @oxide-ts/http JS handler fights the client for the main thread.
//
// Run: node bench/servers.mjs <target> <port>
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));

const target = process.argv[2];
const port = Number(process.argv[3]);
const PAYLOAD = { hello: 'world', ok: true, n: 42 };

const starters = {
  async 'oxide'() {
    const { Server } = await import(join(here, '../js/index.ts'));
    const app = new Server();
    app.get('/json', (c) => c.json(PAYLOAD));
    app.get('/text', (c) => c.text('ok'));
    await app.listen({ port, host: '127.0.0.1' });
  },

  // Native endpoint: answered entirely in Rust, JS never wakes. Shows the cost of the
  // bridge itself — the difference between this line and /json.
  async 'oxide-native'() {
    const { Server } = await import(join(here, '../js/index.ts'));
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
  console.error(`unknown participant: ${target}`);
  process.exit(2);
}
await start();
console.log('ready');
