// Фикстура для теста SIGTERM: поднимается, печатает 'ready', медленно отвечает.
// Родительский тест шлёт SIGTERM во время запроса и проверяет, что ответ дожался,
// а процесс вышел с кодом 0 (§10 graceful shutdown).
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
