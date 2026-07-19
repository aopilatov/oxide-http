// Survivability tests (§17): leaks, panics, "the process stays up".
// The load is kept moderate so the suite stays fast; large runs (N=1e6) belong to
// CI/benchmarks, see BENCHMARKS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Server } from '../js/index.ts';
const here = dirname(fileURLToPath(import.meta.url));

let PORT = 21800;
const nextPort = () => PORT++;

async function up(build) {
  const server = new Server(build.config ?? {});
  build.routes(server);
  const port = nextPort();
  await server.listen({ port, host: '127.0.0.1' });
  return { port, server, close: () => server.close() };
}

/** Run N requests in batches of `concurrency`. */
async function hammer(url: string, total: number, concurrency = 32, init?: RequestInit) {
  let done = 0;
  const statuses = new Map();
  const worker = async () => {
    while (done < total) {
      done++;
      const res = await fetch(url, init);
      await res.arrayBuffer(); // the body must be drained or the socket leaks
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return statuses;
}

test('M12: under load memory plateaus instead of growing linearly', async () => {
  // Measured in a child process with --expose-gc: without forced GC the RSS numbers are
  // so noisy the test would measure the phase of the moon rather than a leak.
  const port = nextPort();
  const child = spawn(
    process.execPath,
    ['--expose-gc', join(here, 'fixtures/memory-blocks.ts'), String(port), '15000', '4'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));

  const code = await new Promise<any>((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, `the measurement failed (code=${code}):\n${err}`);

  const line = out.split('\n').find((l) => l.trim().startsWith('{'));
  assert.ok(line, `no measurement result:\n${out}${err}`);
  const { samples } = JSON.parse(line);

  const mb = (n) => n / 1024 / 1024;
  const rss = samples.map((s) => s.rss);
  const dump = samples
    .map((s, i) => `  block ${i}: rss=${mb(s.rss).toFixed(1)}MB heap=${mb(s.heapUsed).toFixed(1)}MB`)
    .join('\n');

  // The threshold is deliberately relative: absolute megabytes depend on the machine
  // (a two-core CI runner spins up fewer tokio workers and has a different baseline RSS),
  // and a fixed 40MB fired falsely there on ordinary allocator noise.
  // A leak grows proportionally to the block size — 25% will not miss it.
  const spreadPct = ((Math.max(...rss) - Math.min(...rss)) / Math.min(...rss)) * 100;
  assert.ok(spreadPct < 25, `RSS spread ${spreadPct.toFixed(1)}% — looks like a leak\n${dump}`);

  // The primary sign of a JS leak is a growing heap. The threshold stays strict here:
  // heapUsed does not depend on worker count and holds flat on a plateau.
  const heapGrowthMb = mb(samples.at(-1).heapUsed - samples[0].heapUsed);
  assert.ok(heapGrowthMb < 5, `heapUsed grew by ${heapGrowthMb.toFixed(1)}MB — we are retaining objects in JS\n${dump}`);
});

test('M12: 5k requests with bodies are handled without losses', async () => {
  const s = await up({
    routes: (app) => app.post('/echo', async (c) => c.json({ len: (await c.req.text()).length })),
  });
  try {
    const url = `http://127.0.0.1:${s.port}/echo`;
    const init = { method: 'POST', body: 'x'.repeat(16 * 1024) };
    const statuses = await hammer(url, 5000, 16, init);
    assert.equal(statuses.get(200), 5000, 'every request must succeed');
    assert.equal(statuses.size, 1, `no unexpected statuses allowed: ${[...statuses.keys()]}`);
  } finally {
    await s.close();
  }
});

test('M12: a throw in every request neither kills the process nor leaks', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/boom', () => {
        throw new Error('deliberate handler failure');
      }),
  });
  try {
    const statuses = await hammer(`http://127.0.0.1:${s.port}/boom`, 3000);
    assert.equal(statuses.get(500), 3000, 'every request must get a 500');
    // The process is alive — otherwise we would not be here.
    assert.equal(s.server.listening, true);
  } finally {
    await s.close();
  }
});

test('M12: unhandledRejection does not fire under load', async () => {
  const seen: unknown[] = [];
  const onUnhandled = (r) => seen.push(r);
  process.on('unhandledRejection', onUnhandled);

  const s = await up({
    routes: (app) => {
      app.get('/ok', (c) => c.text('ok'));
      app.get('/throw', () => {
        throw new Error('boom');
      });
      app.get('/reject', async () => Promise.reject(new Error('rejected')));
      app.post('/body', async (c) => c.text(await c.req.text()));
    },
  });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    await Promise.all([
      hammer(`${base}/ok`, 1500),
      hammer(`${base}/throw`, 1500),
      hammer(`${base}/reject`, 1500),
      hammer(`${base}/body`, 1500, 32, { method: 'POST', body: 'payload' }),
    ]);
    await new Promise<void>((r) => setTimeout(r, 200)); // let the microtask queue settle
    assert.deepEqual(seen, [], `unhandledRejection must not fire: ${seen}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await s.close();
  }
});

test('M12: client-aborted requests do not accumulate resources', async () => {
  const s = await up({
    routes: (app) =>
      app.get('/slow', async (c) => {
        await new Promise<void>((r) => setTimeout(r, 300));
        return c.text('too-late');
      }),
  });
  try {
    // The client leaves without waiting for the response — the server must cope calmly.
    for (let i = 0; i < 200; i++) {
      const ctrl = new AbortController();
      const p = fetch(`http://127.0.0.1:${s.port}/slow`, { signal: ctrl.signal }).catch(() => {});
      setTimeout(() => ctrl.abort(), 10);
      await p;
    }
    await new Promise<void>((r) => setTimeout(r, 400));

    // The server still serves.
    const res = await fetch(`http://127.0.0.1:${s.port}/slow`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'too-late');
  } finally {
    await s.close();
  }
});

test('M12: 30 listen/close cycles accumulate no ports or handles', async () => {
  for (let i = 0; i < 30; i++) {
    const app = new Server();
    app.get('/', (c) => c.text(String(i)));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await app.inject({ path: '/' });
    assert.equal(res.text(), String(i));
    await app.close();
  }
});
