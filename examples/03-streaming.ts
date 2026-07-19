// Streaming with backpressure (§9): the response body flows through the bridge and the
// producer slows down when the client cannot keep up.
import { Server } from '../js/index.ts';

const app = new Server();

// SSE: an event stream.
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

// A large response via an async generator — memory stays flat.
app.get('/big', (c) =>
  c.body(
    (async function* () {
      for (let i = 0; i < 10_000; i++) yield `line ${i}\n`;
    })(),
  ),
);

// Reading the request body as a stream: a file of any size is never fully buffered.
app.post('/upload', async (c) => {
  let bytes = 0;
  for await (const chunk of c.req.stream) bytes += chunk.length;
  return c.json({ bytes });
});

await app.listen({ port: 3002 });
console.log('http://127.0.0.1:3002');
