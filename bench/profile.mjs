// Профиль перехода границы: гоняет варианты из profile-servers.mjs и печатает
// раскладку «мкс на запрос» по слоям. Запуск: node bench/profile.mjs [--duration=8]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const DURATION_MS = arg('duration', 8) * 1000;
const CONNECTIONS = arg('connections', 64);
const WARMUP_MS = 2000;

const VARIANTS = [
  { id: 'native', name: 'native (JS не будится)' },
  { id: 'bridge', name: 'bridge (TSFN + MatchedRequest)' },
  { id: 'ctx', name: 'ctx (+ buildContext)' },
  { id: 'full', name: 'full (+ луковица и хуки)' },
];

function once(agent, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...opts, agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function load(opts, ms) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: CONNECTIONS });
  let count = 0;
  let errors = 0;
  const deadline = Date.now() + ms;
  const worker = async () => {
    while (Date.now() < deadline) {
      try {
        const status = await once(agent, opts);
        if (status !== 200) errors++;
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
  return { rps: Math.round(count / elapsed), errors };
}

async function startServer(id, port) {
  const child = spawn(process.execPath, [join(here, 'profile-servers.mjs'), id, String(port)], {
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
    throw new Error(`${id} не поднялся:\n${err}`);
  }
  return child;
}

const rows = [];
let port = 24000;
for (const v of VARIANTS) {
  const child = await startServer(v.id, port);
  const opts = { host: '127.0.0.1', port, path: '/json', method: 'GET' };
  try {
    await load(opts, WARMUP_MS);
    const r = await load(opts, DURATION_MS);
    const usPerReq = 1e6 / r.rps;
    rows.push({ ...v, ...r, usPerReq });
    console.log(
      `${v.name.padEnd(32)} rps=${String(r.rps).padStart(7)}  ${usPerReq.toFixed(2)} мкс/запрос  ошибок=${r.errors}`,
    );
  } finally {
    child.kill('SIGKILL');
    port++;
    await new Promise((r) => setTimeout(r, 300));
  }
}

console.log('\n--- раскладка (разности соседних слоёв) ---');
for (let i = 1; i < rows.length; i++) {
  const delta = rows[i].usPerReq - rows[i - 1].usPerReq;
  console.log(`${rows[i].name.padEnd(32)} +${delta.toFixed(2)} мкс`);
}
const total = rows.at(-1).usPerReq - rows[0].usPerReq;
console.log(`${'ИТОГО сверх нативного пути'.padEnd(32)} +${total.toFixed(2)} мкс`);

console.log('\n--- JSON ---');
console.log(JSON.stringify({ node: process.version, connections: CONNECTIONS, rows }, null, 2));
