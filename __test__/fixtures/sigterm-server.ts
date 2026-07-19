// Fixture for the SIGTERM test: starts up, prints 'ready', answers slowly.
// The parent test sends SIGTERM mid-request and checks that the response completed and
// the process exited with code 0 (§10 graceful shutdown).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Server } from '../../js/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.argv[2]);
const app = new Server();
app.get('/slow', async (c) => {
  await new Promise<void>((r) => setTimeout(r, 700));
  return c.text('drained');
});

await app.listen({ port, host: '127.0.0.1' });
console.log('ready');
