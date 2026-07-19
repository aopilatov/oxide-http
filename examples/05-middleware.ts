// Луковица middleware и хуки жизненного цикла (§6, §6a).
//
// Порядок: onRequest → preParsing → preValidation → preHandler →
//          [middleware → хендлер] → preSerialization → onSend → onResponse.
import { Server, HttpError } from '../js/index.ts';

const app = new Server({ requestTimeout: '5s' });

// Глобальный middleware: замер длительности вокруг всей обработки.
app.use(async (c, next) => {
  const t0 = Date.now();
  await next();
  c.res.headers.set('x-response-time', `${Date.now() - t0}ms`);
});

// Middleware по префиксу — работает только на /admin/*.
app.use('/admin', async (c, next) => {
  if (c.req.header('authorization') !== 'Bearer секрет') {
    throw new HttpError(401, 'нужна авторизация');
  }
  await next();
});

// Хуки: onRequest срабатывает до разбора тела.
app.onRequest((c) => {
  c.set('requestStartedAt', Date.now());
});

// onSend — последняя точка, где можно доработать заголовки.
app.onSend((c) => {
  c.res.headers.set('x-powered-by', 'oxide');
});

// Единый обработчик ошибок; HttpError несёт статус.
app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  c.log.error('запрос упал', { path: c.req.path, err: String(err) });
  return c.json({ error: String(err instanceof Error ? err.message : err) }, status);
});

// Таймаут запроса → 504; сюда же приходит сигнал отмены.
app.onTimeout((c) => {
  c.log.warn('таймаут', { path: c.req.path });
});

app.get('/admin/stats', (c) => c.json({ ok: true }));
app.get('/slow', async (c) => {
  // c.req.signal прерывается по таймауту/дисконнекту — передавайте его в fetch/БД.
  await new Promise((r) => setTimeout(r, 100));
  return c.text('успел');
});

// Группы: суб-приложение монтируется под префиксом.
const api = new Server();
api.get('/ping', (c) => c.text('pong'));
app.route('/api/v1', api);

await app.listen({ port: 3004 });
console.log('http://127.0.0.1:3004');
