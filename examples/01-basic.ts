// Basic API: routes, params, query, headers, cookies.
// Run: node examples/01-basic.ts
//
// In your own project the import looks like this:
//   import { Server } from '@oxide-ts/http';
import { Server } from '../js/index.ts';

const app = new Server({ accessLog: true });

app.get('/', (c) => c.text('hello'));

// Path params: one parameter per segment (a matchit limitation, see DESIGN §5).
app.get('/users/:id', (c) => c.json({ id: c.req.params.id }));

// Query: last-wins in c.req.query, all values via queries().
app.get('/search', (c) =>
  c.json({ q: c.req.query.q, tags: c.req.queries('tag') }),
);

// A returned value works as sugar: object → json, string → text.
app.get('/sugar', () => ({ ok: true }));

app.post('/echo', async (c) => c.json(await c.req.json()));

// Cookies and headers.
app.get('/session', (c) => {
  c.cookie('sid', 'abc123', { httpOnly: true, sameSite: 'lax', maxAge: 3600 });
  return c.json({ prev: c.req.cookie('sid') ?? null, ip: c.req.ip });
});

// Rust answers 404 without waking JS; override it when you need to.
app.notFound((c) => c.json({ error: 'no such route', path: c.req.path }, 404));

await app.listen({ port: 3000 });
console.log('http://127.0.0.1:3000');
