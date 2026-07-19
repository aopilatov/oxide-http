// The middleware onion and lifecycle hooks (§6, §6a).
//
// Order: onRequest → preParsing → preValidation → preHandler →
//        [middleware → handler] → preSerialization → onSend → onResponse.
import { Server, HttpError } from '../js/index.ts';

const app = new Server({ requestTimeout: '5s' });

// Global middleware: measures the duration around the whole handling.
app.use(async (c, next) => {
  const t0 = Date.now();
  await next();
  c.res.headers.set('x-response-time', `${Date.now() - t0}ms`);
});

// Prefixed middleware — applies only under /admin/*.
app.use('/admin', async (c, next) => {
  if (c.req.header('authorization') !== 'Bearer secret') {
    throw new HttpError(401, 'authorization required');
  }
  await next();
});

// Hooks: onRequest fires before the body is parsed.
app.onRequest((c) => {
  c.set('requestStartedAt', Date.now());
});

// onSend is the last place where headers can still be adjusted.
app.onSend((c) => {
  c.res.headers.set('x-powered-by', 'oxide');
});

// The unified error handler; HttpError carries the status.
app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  c.log.error('request failed', { path: c.req.path, err: String(err) });
  return c.json({ error: String(err instanceof Error ? err.message : err) }, status);
});

// Request timeout → 504; the cancellation signal arrives here too.
app.onTimeout((c) => {
  c.log.warn('timeout', { path: c.req.path });
});

app.get('/admin/stats', (c) => c.json({ ok: true }));
app.get('/slow', async (c) => {
  // c.req.signal aborts on timeout/disconnect — pass it to fetch/database calls.
  await new Promise((r) => setTimeout(r, 100));
  return c.text('made-it');
});

// Groups: a sub-application mounted under a prefix.
const api = new Server();
api.get('/ping', (c) => c.text('pong'));
app.route('/api/v1', api);

await app.listen({ port: 3004 });
console.log('http://127.0.0.1:3004');
