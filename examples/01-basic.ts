// Базовый API: маршруты, параметры, query, заголовки, cookies.
// Запуск: node examples/01-basic.ts
//
// В своём проекте импорт выглядит так:
//   import { Server } from '@oxide-ts/http';
import { Server } from '../js/index.ts';

const app = new Server({ accessLog: true });

app.get('/', (c) => c.text('привет'));

// Параметры пути: один параметр на сегмент (ограничение matchit, см. DESIGN §5).
app.get('/users/:id', (c) => c.json({ id: c.req.params.id }));

// Query: last-wins в c.req.query, все значения — через queries().
app.get('/search', (c) =>
  c.json({ q: c.req.query.q, tags: c.req.queries('tag') }),
);

// Возврат значения работает как сахар: объект → json, строка → text.
app.get('/sugar', () => ({ ok: true }));

app.post('/echo', async (c) => c.json(await c.req.json()));

// Cookies и заголовки.
app.get('/session', (c) => {
  c.cookie('sid', 'abc123', { httpOnly: true, sameSite: 'lax', maxAge: 3600 });
  return c.json({ prev: c.req.cookie('sid') ?? null, ip: c.req.ip });
});

// 404 отдаёт Rust без пробуждения JS; переопределяется при необходимости.
app.notFound((c) => c.json({ error: 'нет такого маршрута', path: c.req.path }, 404));

await app.listen({ port: 3000 });
console.log('http://127.0.0.1:3000');
