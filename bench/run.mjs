// Benchmark harness (§17). Run: `node bench/run.mjs [--duration=10] [--connections=64]`
//
// Methodology:
// · every server runs in a SEPARATE process (bench/servers.mjs) — otherwise the load
//   generator competes with the server for the event loop, putting a native server that
//   crosses into JS at a clear disadvantage;
// · the client is `node:http` with a keep-alive agent, no external dependencies;
// · 2s warm-up, then measurement; we report RPS and latencies.
//
// LIMITATION: the generator is Node too, and against fast servers it becomes the
// bottleneck itself. Read the numbers as **relative**, on one client and one machine.
// Authoritative measurements need an external generator (oha/bombardier/h2load),
// preferably from a separate machine; the scenario is described in BENCHMARKS.md.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const DURATION_MS = arg('duration', 10) * 1000;
const CONNECTIONS = arg('connections', 64);
const WARMUP_MS = 2000;

const TARGETS = [
  { id: 'oxide', name: '@oxide-ts/http' },
  { id: 'oxide-native', name: '@oxide-ts/http (native endpoint)' },
  { id: 'node-http', name: 'node:http' },
  { id: 'fastify', name: 'fastify' },
  { id: 'hono', name: 'hono (node-server)' },
];

function once(agent, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...opts, agent }, (res) => {
      res.resume(); // drain the body, otherwise the connection is not reused
      res.on('end', () => resolve(res.statusCode));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function load(opts, ms) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONNECTIONS });
  const latencies = [];
  let count = 0;
  let errors = 0;
  const deadline = Date.now() + ms;

  const worker = async () => {
    while (Date.now() < deadline) {
      const t0 = process.hrtime.bigint();
      try {
        const status = await once(agent, opts);
        if (status !== 200) errors++;
        latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
        count++;
      } catch {
        errors++;
      }
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: CONNECTIONS }, worker));
  const elapsed = (Date.now() - started) / 1000;
  agent.destroy();

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
  return {
    rps: Math.round(count / elapsed),
    p50: +pct(0.5).toFixed(2),
    p99: +pct(0.99).toFixed(2),
    errors,
  };
}

/** Start a server in a separate process; `null` if the participant is not installed. */
async function startServer(id, port) {
  const child = spawn(process.execPath, [join(here, 'servers.mjs'), id, String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));

  const ready = await new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('ready')) resolve(true);
    });
    child.on('exit', () => resolve(false));
    setTimeout(() => resolve(false), 8000);
  });

  if (!ready) {
    child.kill('SIGKILL');
    return { child: null, err };
  }
  return { child, err };
}

const results = [];
let port = 23000;

for (const target of TARGETS) {
  const { child, err } = await startServer(target.id, port);
  if (!child) {
    const missing = /Cannot find (package|module)/.test(err);
    console.log(`· ${target.name}: ${missing ? 'not installed, skipping' : 'failed to start'}`);
    port++;
    continue;
  }

  const opts = { host: '127.0.0.1', port, path: '/json', method: 'GET' };
  try {
    await load(opts, WARMUP_MS);
    const r = await load(opts, DURATION_MS);
    results.push({ name: target.name, ...r });
    console.log(
      `${target.name.padEnd(30)} rps=${String(r.rps).padStart(7)}  p50=${r.p50}ms  p99=${r.p99}ms  errors=${r.errors}`,
    );
  } finally {
    child.kill('SIGKILL');
    port++;
    await new Promise((r) => setTimeout(r, 300)); // let the port free up
  }
}

console.log('\n--- summary (JSON) ---');
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: (await import('node:os')).cpus().length,
      connections: CONNECTIONS,
      durationSec: DURATION_MS / 1000,
      results,
    },
    null,
    2,
  ),
);
