// Fixture for the "one signal handler per process" check (C4).
//
// Two servers in one process, both slow. The parent sends SIGTERM mid-request to both
// and expects BOTH responses to complete. With a per-instance signal handler each server
// called process.exit() after its own drain, so whichever finished first killed the
// process and the other request died with it.
import { Server } from '../../js/index.ts';

const portA = Number(process.argv[2]);
const portB = Number(process.argv[3]);

const slow = (label: string, ms: number) => {
  const app = new Server();
  app.get('/slow', async (c) => {
    await new Promise<void>((r) => setTimeout(r, ms));
    return c.text(`drained-${label}`);
  });
  return app;
};

// Deliberately different drain durations: the fast one finishing must not cut the slow
// one short.
const a = slow('a', 200);
const b = slow('b', 800);

await a.listen({ port: portA, host: '127.0.0.1' });
await b.listen({ port: portB, host: '127.0.0.1' });
console.log('ready');
