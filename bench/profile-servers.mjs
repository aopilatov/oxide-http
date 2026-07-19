// Layer-by-layer breakdown of the boundary-crossing cost (§17). Each variant runs in
// its own process.
//
//   native  — answered entirely in Rust, JS never wakes (baseline)
//   bridge  — RustServer directly, the callback returns a constant: the pure cost of
//             TSFN + Promise + MatchedRequest construction, without our wrapper
//   ctx     — bridge + buildContext (the context `c` is built, but there is no onion)
//   full    — the public Server with the whole wrapper
//
// The differences between neighbours give the breakdown.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { RustServer } = await import(join(here, '../index.js'));
const { Server } = await import(join(here, '../js/index.ts'));
const { buildContext, buildNativeResponse } = await import(join(here, '../js/context.ts'));

const variant = process.argv[2];
const port = Number(process.argv[3]);
const PAYLOAD = { hello: 'world', ok: true, n: 42 };
const BODY = JSON.stringify(PAYLOAD);

/** Minimal options for a raw RustServer (the wrapper normally fills these in). */
const baseOptions = {
  customIpHeaders: [],
  customCountryHeaders: [],
  requestIdHeader: 'x-request-id',
  bodyLimit: 10 * 1024 * 1024,
};

const JSON_HEADERS = [{ key: 'content-type', value: 'application/json' }];

// Keep references to the servers: without them V8 collects the object, the native Drop
// shuts the runtime down and the server dies silently under load. The public `Server` is
// protected from this (the dispatcher callback captures `this`); a raw `RustServer` is not.
const alive = [];

const variants = {
  // JS never wakes: the path is served by a native endpoint (§11).
  async native() {
    const app = new Server({ health: { path: '/json' } });
    alive.push(app);
    await app.listen({ port, host: '127.0.0.1' });
  },

  // The boundary is there but the wrapper is not: the callback returns a ready response.
  async bridge() {
    const native = new RustServer();
    alive.push(native);
    native.listen(
      port,
      '127.0.0.1',
      [{ method: 'GET', path: '/json', leafId: 0 }],
      false,
      baseOptions,
      () => Promise.resolve({ status: 200, headers: JSON_HEADERS, body: BODY }),
    );
  },

  // ONLY reads the napi object's fields, with no logic: separates the cost of accessing
  // data across the boundary from the cost of our JS code.
  async touch() {
    const native = new RustServer();
    alive.push(native);
    native.listen(
      port,
      '127.0.0.1',
      [{ method: 'GET', path: '/json', leafId: 0 }],
      false,
      baseOptions,
      ([req]) => {
        let sink = 0;
        for (const { key, value } of req.headers) sink += key.length + value.length;
        for (const { key, value } of req.query) sink += key.length + value.length;
        sink += req.method.length + req.path.length + req.ip.length + req.id.length;
        sink += req.ips.length + (req.country ? 1 : 0) + (req.validBody ? 1 : 0);
        if (sink < 0) throw new Error('unreachable');
        return Promise.resolve({ status: 200, headers: JSON_HEADERS, body: BODY });
      },
    );
  },

  // The boundary plus building the context `c`, but without the middleware/hook chain.
  async ctx() {
    const native = new RustServer();
    alive.push(native);
    native.listen(
      port,
      '127.0.0.1',
      [{ method: 'GET', path: '/json', leafId: 0 }],
      false,
      baseOptions,
      ([req, bodyIo]) => {
        const c = buildContext(req, bodyIo, {
          baseUrl: '',
          requestIdHeader: 'x-request-id',
          bodyLimit: 10 * 1024 * 1024,
          responseStrip: null,
        });
        c.json(PAYLOAD);
        return Promise.resolve(buildNativeResponse(c));
      },
    );
  },

  // The full public path.
  async full() {
    const app = new Server();
    alive.push(app);
    app.get('/json', (c) => c.json(PAYLOAD));
    await app.listen({ port, host: '127.0.0.1' });
  },
};

const start = variants[variant];
if (!start) {
  console.error(`unknown variant: ${variant}`);
  process.exit(2);
}
await start();

// Main-thread utilization: shows whether a variant is bound by the event loop.
// native should read ~0 (JS never wakes); a JS path should approach 1.0.
if (process.env.OXIDE_BENCH_ELU) {
  const { performance } = await import('node:perf_hooks');
  let last = performance.eventLoopUtilization();
  setInterval(() => {
    const cur = performance.eventLoopUtilization();
    console.log(`ELU=${performance.eventLoopUtilization(cur, last).utilization.toFixed(3)}`);
    last = cur;
  }, 2000);
}

console.log('ready');
