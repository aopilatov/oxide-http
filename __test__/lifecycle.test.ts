import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

import { Server } from '../js/index.ts';
const here = dirname(fileURLToPath(import.meta.url));

let PORT = 21000;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config ?? {});
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, server, close: () => server.close() };
}

test('M10a: listen emits listening, close emits shutdown+close', async () => {
  const server = new Server();
  server.get('/', (c) => c.text('ok'));
  const seen: any[] = [];
  server.on('listening', (info) => seen.push(['listening', info.port]));
  server.on('shutdown', () => seen.push(['shutdown']));
  server.on('close', () => seen.push(['close']));

  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  assert.equal(server.listening, true);
  await server.close();
  assert.equal(server.listening, false);

  assert.deepEqual(seen, [['listening', port], ['shutdown'], ['close']]);
});

test('M10a: a busy port → listen rejects and emits error', async () => {
  const first = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  try {
    const second = new Server();
    second.get('/', (c) => c.text('dup'));
    let emitted: unknown = null;
    second.on('error', (e) => (emitted = e));

    await assert.rejects(
      () => second.listen({ port: first.port, host: '127.0.0.1' }),
      /Address already in use|bind/,
    );
    assert.ok(emitted, 'the error event must fire');
    assert.equal(second.listening, false);
  } finally {
    await first.close();
  }
});

test('M10a: close() waits for the in-flight request', async () => {
  let handlerDone = false;
  const s = await up({
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise<void>((r) => setTimeout(r, 600));
        handlerDone = true;
        return c.text('finished');
      }),
  });

  // Request in flight, the response has not arrived yet.
  const inflight = fetch(`http://127.0.0.1:${s.port}/slow`);
  await new Promise<void>((r) => setTimeout(r, 150));

  await s.close(); // must wait rather than cut it off
  assert.equal(handlerDone, true, 'the handler must have finished before close() resolved');

  const res = await inflight;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'finished');
});

test('M10a: the port frees immediately — binding right after close() works', async () => {
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('first')) });
  await s.close();

  // The same port must be free immediately after close() resolves.
  const again = new Server();
  again.get('/', (c) => c.text('second'));
  await again.listen({ port: s.port, host: '127.0.0.1' });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(await res.text(), 'second');
  } finally {
    await again.close();
  }
});

test('M10a: close() is idempotent, concurrent calls await one drain', async () => {
  const s = await up({ routes: (app) => app.get('/', (c) => c.text('ok')) });
  const closes = [s.close(), s.close(), s.close()];
  await Promise.all(closes);
  await s.close(); // after completion this is a no-op too
  assert.equal(s.server.listening, false);
});

test('M10a: shutdownTimeout cuts off a stuck request', async () => {
  const s = await up({
    config: { shutdownTimeout: '300ms' },
    routes: (app) =>
      app.get('/stuck', async (c) => {
        await new Promise<void>((r) => setTimeout(r, 10_000)); // longer than the deadline
        return c.text('never');
      }),
  });

  const inflight = fetch(`http://127.0.0.1:${s.port}/stuck`).catch((e: any) => e);
  await new Promise<void>((r) => setTimeout(r, 150));

  const t0 = Date.now();
  await s.close();
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 3000, `close() must fit within the deadline, took ${elapsed}ms`);
  await inflight; // the connection was cut — fetch rejects, which is expected
});

test('M10a: during shutdown new connections are not accepted', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise<void>((r) => setTimeout(r, 500));
        return c.text('ok');
      }),
  });

  const inflight = fetch(`http://127.0.0.1:${s.port}/slow`);
  await new Promise<void>((r) => setTimeout(r, 100));

  const closing = s.close();
  await new Promise<void>((r) => setTimeout(r, 100)); // the listener is closed, the drain is running

  const refused = await new Promise<any>((resolve) => {
    const sock = net.connect(s.port, '127.0.0.1');
    sock.on('connect', () => {
      sock.destroy();
      resolve(false);
    });
    sock.on('error', () => resolve(true));
  });
  assert.equal(refused, true, 'the listener must be closed before the drain ends');

  await closing;
  assert.equal((await inflight).status, 200, 'the in-flight request must finish');
});

test('M10a: SIGTERM → graceful shutdown and exit 0', async () => {
  const port = nextPort();
  const child = spawn(process.execPath, [join(here, 'fixtures/sigterm-server.ts'), String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // Wait until it is ready.
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => (String(d).includes('ready') ? resolve() : null));
      child.on('exit', () => reject(new Error('the process died before becoming ready')));
      setTimeout(() => reject(new Error('the server did not start')), 5000);
    });

    const inflight = fetch(`http://127.0.0.1:${port}/slow`);
    await new Promise<void>((r) => setTimeout(r, 150));
    child.kill('SIGTERM');

    const res = await inflight;
    assert.equal(res.status, 200, 'the in-flight request must survive SIGTERM');
    assert.equal(await res.text(), 'drained');

    const code = await new Promise<any>((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, 'the process must exit with code 0');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('M10a: h2 receives GOAWAY on shutdown while the current stream finishes', async () => {
  const http2 = await import('node:http2');
  const s = await up({
    config: { h2c: true },
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise<void>((r) => setTimeout(r, 500));
        return c.text('h2-drained');
      }),
  });

  const client = http2.connect(`http://127.0.0.1:${s.port}`);
  let goaway = false;
  client.on('goaway', () => (goaway = true));

  const body = await new Promise<any>((resolve, reject) => {
    const req = client.request({ ':path': '/slow' });
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (d += chunk));
    req.on('end', () => resolve(d));
    req.on('error', reject);
    req.end();
    // Trigger the shutdown while the stream is in flight.
    setTimeout(() => s.close(), 150);
  });

  assert.equal(body, 'h2-drained', 'the in-flight stream must finish');
  assert.equal(goaway, true, 'the client must receive GOAWAY');
  client.close();
});
