// Стриминг с backpressure (§9): тело ответа течёт через мост, producer
// притормаживается, когда клиент не успевает читать.
import { Server } from '../js/index.ts';

const app = new Server();

// SSE: поток событий.
app.get('/events', (c) => {
  c.header('content-type', 'text/event-stream');
  c.header('cache-control', 'no-cache');
  return c.body(
    new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(`data: ${new Date().toISOString()}\n\n`));
        await new Promise((r) => setTimeout(r, 1000));
      },
    }),
  );
});

// Большой ответ через async-генератор — память не растёт.
app.get('/big', (c) =>
  c.body(
    (async function* () {
      for (let i = 0; i < 10_000; i++) yield `строка ${i}\n`;
    })(),
  ),
);

// Чтение тела запроса потоком: файл любого размера не буферизуется целиком.
app.post('/upload', async (c) => {
  let bytes = 0;
  for await (const chunk of c.req.stream) bytes += chunk.length;
  return c.json({ bytes });
});

await app.listen({ port: 3002 });
console.log('http://127.0.0.1:3002');
