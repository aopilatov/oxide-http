// Schema validation (§6b): the structural part is checked in Rust BEFORE JS wakes up —
// an invalid request gets a 400 without spending a single event-loop tick.
// valibot then applies transform/refine, which JSON Schema cannot express.
//
// Requires: npm i valibot @valibot/to-json-schema
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
        // transform is JS and never reaches Rust: it runs in preValidation
        email: v.pipe(v.string(), v.transform((s) => s.toLowerCase())),
      }),
      // The response is stripped by the schema: anything not in it never leaks
      response: {
        200: v.object({ id: v.string(), name: v.string() }),
      },
    },
  },
  (c) => {
    const body = c.req.valid<{ name: string; age: number; email: string }>('body');
    // secret is present in the response but absent from the response schema → stripped
    return c.json({ id: 'u1', name: body.name, email: body.email, secret: 'will-not-leak' });
  },
);

// Query coercion by schema types: ?limit=10 arrives as a number, not a string.
app.get(
  '/items',
  { schema: { query: v.object({ limit: v.number() }) } },
  (c) => c.json({ limit: c.req.valid<{ limit: number }>('query').limit }),
);

await app.listen({ port: 3001 });
console.log('http://127.0.0.1:3001');
