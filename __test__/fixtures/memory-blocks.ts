// Per-block memory measurement (§17). Started by the parent test with --expose-gc:
// without forced GC the RSS numbers are noisy and measure the wrong thing.
//
// The idea: a leak grows linearly (every block adds X MB), while one-off allocator
// warm-up and arena growth plateau. So we discard the first block after the warm-up and
// look at the growth between steady-state blocks.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Server } from '../../js/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.argv[2]);
const blockSize = Number(process.argv[3] ?? 15000);
const blocks = Number(process.argv[4] ?? 4);

const app = new Server();
app.get('/ping', (c) => c.json({ ok: true }));
app.post('/echo', async (c) => c.text(await c.req.text()));
await app.listen({ port, host: '127.0.0.1' });

const base = `http://127.0.0.1:${port}`;

async function hammer(url: string, total: number, concurrency = 32, init?: RequestInit) {
  let done = 0;
  const worker = async () => {
    while (done < total) {
      done++;
      const res = await fetch(url, init);
      await res.arrayBuffer();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function settle() {
  global.gc?.();
  await new Promise<void>((r) => setTimeout(r, 250));
  global.gc?.();
}

const body = 'x'.repeat(8 * 1024);
const runBlock = async () => {
  await hammer(`${base}/ping`, blockSize);
  await hammer(`${base}/echo`, Math.floor(blockSize / 10), 16, { method: 'POST', body });
};

await runBlock(); // warm-up: pools, JIT, allocator arenas
await settle();

const samples: Array<{ rss: number; heapUsed: number; external: number }> = [];
for (let i = 0; i < blocks; i++) {
  await runBlock();
  await settle();
  const m = process.memoryUsage();
  samples.push({ rss: m.rss, heapUsed: m.heapUsed, external: m.external });
}

console.log(JSON.stringify({ blockSize, samples }));
await app.close();
