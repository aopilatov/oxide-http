// Fixture for the access-log check: the log is written from Rust to stdout, so a separate
// process is required — the parent test reads its stdout line by line (§11).
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Server } from '../../js/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.argv[2]);
const app = new Server({ accessLog: true });
app.get('/hello', (c) => c.text('hi'));

await app.listen({ port, host: '127.0.0.1' });
console.log('ready');
