// Валидация по схемам (§6b): структурная часть проверяется в Rust ДО пробуждения
// JS — невалидный запрос получает 400, не потратив ни такта event loop.
// valibot доигрывает transform/refine, которые в JSON Schema не выражаются.
//
// Нужны пакеты: npm i valibot @valibot/to-json-schema
import * as v from 'valibot';

import { Server } from '../js/index.ts';

const app = new Server();

app.post(
  '/users',
  {
    schema: {
      body: v.object({
        name: v.pipe(v.string(), v.minLength(2)),
        age: v.pipe(v.number(), v.minValue(0)),
        // transform — это JS, в Rust не уходит: доигрывается в preValidation
        email: v.pipe(v.string(), v.transform((s) => s.toLowerCase())),
      }),
      // Ответ отсекается по схеме: чего нет в схеме — не утечёт наружу
      response: {
        200: v.object({ id: v.string(), name: v.string() }),
      },
    },
  },
  (c) => {
    const body = c.req.valid<{ name: string; age: number; email: string }>('body');
    // secret в ответе есть, но в response-схеме его нет → будет отсечён
    return c.json({ id: 'u1', name: body.name, email: body.email, secret: 'не утечёт' });
  },
);

// Коэрция query по типам из схемы: ?limit=10 придёт числом, а не строкой.
app.get(
  '/items',
  { schema: { query: v.object({ limit: v.number() }) } },
  (c) => c.json({ limit: c.req.valid<{ limit: number }>('query').limit }),
);

await app.listen({ port: 3001 });
console.log('http://127.0.0.1:3001');
