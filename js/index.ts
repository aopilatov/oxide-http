// The public wrapper around the native `RustServer`. Route, middleware (onion) and
// lifecycle-hook registration; routing/matching/404/405 happen in Rust.
// Chains are precompiled on listen() (see pipeline.ts); the context lives in context.ts.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import { RustServer } from '../index.js';
import type {
  CorsOptions as NativeCorsOptions,
  Http2Options as NativeHttp2Options,
  ListenOptions as NativeListenOptions,
  MultipartOptions as NativeMultipartOptions,
  RouteDef as NativeRouteDef,
} from '../index.js';

import { buildContext, buildNativeResponse, HttpError } from './context.ts';
import type {
  BodyIo,
  Context,
  KvPair,
  NativeRequest,
  NativeResponse,
  ResponseStrip,
  RouteSchema,
} from './context.ts';
import { parseBytes, parseDuration } from './units.ts';
import type { ByteSize, Duration } from './units.ts';
import {
  ALL_STAGES,
  buildChain,
  runAfterHooks,
  runCore,
  withTimeout,
} from './pipeline.ts';
import type {
  Chain,
  ErrorHook,
  Handler,
  Hook,
  Middleware,
  Scoped,
  StageName,
} from './pipeline.ts';
import {
  isValibot,
  loadSchemaDeps,
  toJsonSchemaString,
  topProps,
  valibotIssues,
  valibotSafeParse,
} from './schema.ts';
import type { SchemaSource, ValibotSchema, ValidationIssue } from './schema.ts';

export { HttpError } from './context.ts';
export type { Context, CookieOptions, MultipartPart } from './context.ts';
export type { Handler, Middleware, Hook, ErrorHook } from './pipeline.ts';

// --- public configuration types ---

/** CORS (§6a). An `origin` function is not native — write a JS middleware for dynamic logic. */
export interface CorsConfig {
  origin?: string | string[];
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/** TLS (§12): a PEM string, a file path, or a Buffer. */
export interface TlsConfig {
  cert: string | Buffer;
  key: string | Buffer;
}

/** HTTP/2 (§6c A1). */
export interface Http2Config {
  maxConcurrentStreams?: number;
  initialWindowSize?: ByteSize;
  maxResetStreamsPerSec?: number;
}

/** Probes and metrics (§11). An empty path disables the endpoint. */
export interface HealthConfig {
  path?: string;
  readyPath?: string;
  metricsPath?: string;
  /** A separate port: probes and metrics are then absent from the main port. */
  port?: number;
}

/** Multipart limits (§9a). */
export interface MultipartConfig {
  maxFileSize?: ByteSize;
  maxFieldSize?: ByteSize;
  maxFiles?: number;
  maxFields?: number;
  allowedMimeTypes?: string[];
  allowedExtensions?: string[];
}

/** Server configuration. */
export interface ServerConfig {
  baseUrl?: string;
  requestId?: { header?: string };
  /** Max request body size; defaults to `'10mb'`. Pass `null` to remove the limit —
   *  note that this also removes the bound on decompressed size (zip bombs). */
  bodyLimit?: ByteSize | null;
  requestTimeout?: Duration;
  customIpHeaders?: string[];
  customCountryHeaders?: string[];
  cors?: CorsConfig;
  tls?: TlsConfig;
  /** h2c prior-knowledge on the plaintext port (§12). */
  h2c?: boolean;
  http2?: Http2Config;
  // timeouts (§6c A2)
  headerReadTimeout?: Duration;
  bodyReadTimeout?: Duration;
  idleTimeout?: Duration;
  handshakeTimeout?: Duration;
  maxHeaders?: number;
  maxHeaderSize?: ByteSize;
  // lifecycle (§10)
  shutdownTimeout?: Duration;
  /** The "readiness dropped but still accepting" pause — 5–15s under k8s. */
  preShutdownDelay?: Duration;
  handleSignals?: boolean;
  /** Install the process-wide `unhandledRejection` log handler (§8). Default `true`;
   *  skipped anyway when the application already registered its own. */
  installSafetyNet?: boolean;
  /** Watch for client disconnects even with no `onAbort` hook, so `c.req.signal` aborts
   *  when the client goes away. Costs one pending promise per request, hence opt-in;
   *  registering an `onAbort` hook enables the watch on its own. */
  detectDisconnect?: boolean;
  // network and platform (§6c B9, A3, A4)
  backlog?: number;
  reusePort?: boolean;
  noDelay?: boolean;
  maxConnections?: number;
  proxyProtocol?: boolean;
  workerThreads?: number | 'auto';
  // observability (§11)
  health?: HealthConfig;
  accessLog?: boolean;
  // overload (§6c C5)
  maxConcurrentRequests?: number;
  maxQueue?: number;
  queueTimeout?: Duration;
  retryAfter?: number;
  overloadShedAfter?: Duration;
}

/** Route options: schemas, multipart and route-level hooks. */
export type RouteOptions = {
  schema?: RouteSchema;
  multipart?: boolean | MultipartConfig;
} & Partial<Record<StageName, Hook | Hook[]>>;

/** `listen()` arguments: TCP or a Unix socket. */
export interface ListenArgs {
  port?: number;
  host?: string;
  /** Unix socket (§6c B9); when set, `port`/`host` are ignored. */
  path?: string;
}

/** A request for `app.inject()` (§17). */
export interface InjectRequest {
  method?: string;
  path?: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer | string | unknown;
  query?: Record<string, string>;
}

/** The `app.inject()` response. */
export interface InjectResult {
  status: number;
  headers: Record<string, string>;
  rawHeaders: KvPair[];
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

/** Server events (§6d B7). */
export type ServerEvent = 'listening' | 'error' | 'close' | 'shutdown';

/** Payload of the `listening` event: a TCP address or a Unix socket path. */
export interface ListeningInfo {
  port?: number;
  host?: string;
  path?: string;
}

/** Handler signatures per event. */
export interface ServerEventMap {
  listening: (info: ListeningInfo) => void;
  error: (err: unknown) => void;
  close: () => void;
  shutdown: () => void;
}

/** Options for the periodic readiness check (§11). */
export interface ReadinessCheckOptions {
  interval?: number;
  timeout?: number;
}

// --- internal types ---

interface RouteEntry {
  method: string;
  path: string;
  middleware: Middleware[];
  hooks: Partial<Record<StageName, Array<Hook | ErrorHook>>>;
  schema: RouteSchema | null;
  multipart: NativeMultipartOptions | null;
  handler: Handler;
  /** The synthetic valibot preValidation hook is already in `hooks` — see
   *  `injectValidation`. Guards against a second copy when `listen()` is retried after a
   *  failed bind. */
  validationInjected?: boolean;
}

type HooksByStage = Record<StageName, Array<Scoped<Hook | ErrorHook>>>;

// Process-level safety net (§8): normally never fires — if it does, it means a bug in
// the wrapper (an uncaught reject). We log it but do NOT bring the process down.
//
// It is a process-wide handler, so it also catches rejections that have nothing to do
// with this library. When the application registered its own handler we stay out of the
// way: replacing Node's default crash with a log line can leave an app running on broken
// state. `installSafetyNet: false` opts out entirely.
let safetyNetInstalled = false;
function installSafetyNet(): void {
  if (safetyNetInstalled) return;
  if (process.listenerCount('unhandledRejection') > 0) return;
  safetyNetInstalled = true;
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        msg: 'unhandledRejection (a bug in the @oxide-ts/http wrapper — the process stays up)',
        reason: reason instanceof Error ? reason.stack : String(reason),
      }) + '\n',
    );
  });
}

// One SIGTERM/SIGINT handler per process, shared by every server that opted in (§10).
// Per-instance handlers each called process.exit() after their own drain, so with several
// servers the first to finish killed the process while the others were still draining.
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
const signalServers = new Set<Server>();
let removeSignalHandler: (() => void) | null = null;

function onShutdownSignal(): void {
  // Snapshot first: close() removes each server from the set as it finishes.
  const draining = [...signalServers].map((s) => s.close());
  void Promise.allSettled(draining).then((results) => {
    process.exit(results.some((r) => r.status === 'rejected') ? 1 : 0);
  });
}

function registerForSignals(server: Server): void {
  signalServers.add(server);
  if (removeSignalHandler) return;
  for (const sig of SHUTDOWN_SIGNALS) process.on(sig, onShutdownSignal);
  removeSignalHandler = () => {
    for (const sig of SHUTDOWN_SIGNALS) process.off(sig, onShutdownSignal);
  };
}

function unregisterFromSignals(server: Server): void {
  signalServers.delete(server);
  if (signalServers.size > 0 || !removeSignalHandler) return;
  removeSignalHandler();
  removeSignalHandler = null;
}

/** A count/size option that must be a non-negative integer.
 *
 *  The native layer filters these with `n > 0`, so a negative used to be dropped in
 *  silence — turning `maxConnections: -1` into "no limit" instead of a startup error.
 *  Sizes and durations go through `parseBytes`/`parseDuration`, which already reject
 *  negatives; this covers the plain-number options. */
function count(name: string, v: number): number {
  if (!Number.isInteger(v) || v < 0) {
    throw new TypeError(`${name}: expected a non-negative integer, got ${v}`);
  }
  return v;
}

/** Prefix normalization: '' | '/' → ''; a leading slash is required; trailing (and /*) removed. */
function normalizeBase(b: string | undefined): string {
  if (!b || b === '/') return '';
  let s = b.startsWith('/') ? b : '/' + b;
  if (s.endsWith('/*')) s = s.slice(0, -2);
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s || '';
}

/** Join a prefix and a route path (path === '/' does not produce a double slash). */
function join(base: string, path: string): string {
  const p = path.startsWith('/') ? path : '/' + path;
  if (p === '/') return base === '' ? '/' : base;
  return base + p;
}

/** An empty set of hooks per stage. */
function emptyHooks(): HooksByStage {
  const h = {} as HooksByStage;
  for (const stage of ALL_STAGES) h[stage] = [];
  return h;
}

export class Server {
  readonly #native: RustServer;
  #routes: RouteEntry[] = [];
  #mounted: Array<{ prefix: string; sub: Server }> = []; // sub-apps, folded in at listen()
  #middleware: Array<Scoped<Middleware>> = []; // the onion (global plus prefixed)
  #hooks: HooksByStage = emptyHooks();
  #baseUrl = '';
  #notFound: Handler | null = null;
  #chains: Chain[] = []; // precompiled chains by leafId (after listen)
  #notFoundChain: Chain | null = null;
  #responseStrip: Array<ResponseStrip | null> = []; // by leafId
  #options: NativeListenOptions;
  #requestIdHeader: string;
  #bodyLimit: number | undefined;
  #requestTimeout: number | null;
  #events = new EventEmitter();
  #listening = false;
  #closing: Promise<void> | null = null; // makes close() idempotent
  #autostart: Promise<this> | null = null; // in-flight inject() auto-start, shared
  #handleSignals: boolean;
  #installSafetyNet: boolean;
  #detectDisconnect: boolean;
  #readinessTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(config: ServerConfig = {}) {
    this.#baseUrl = normalizeBase(config.baseUrl);
    this.#requestIdHeader = (config.requestId?.header ?? 'x-request-id').toLowerCase();
    // An explicit `bodyLimit: null` means "no limit"; omitting the key keeps the default.
    // Strictly `null`: `== null` also matched an explicit `undefined`, so spreading a
    // config that carried one silently disabled the limit — and with it the bound on
    // decompressed size, i.e. zip-bomb protection.
    this.#bodyLimit =
      config.bodyLimit === null ? undefined : parseBytes(config.bodyLimit ?? '10mb');
    this.#requestTimeout =
      config.requestTimeout != null ? (parseDuration(config.requestTimeout) ?? null) : null;

    const options: NativeListenOptions = {
      customIpHeaders: config.customIpHeaders ?? [],
      customCountryHeaders: config.customCountryHeaders ?? [],
      requestIdHeader: this.#requestIdHeader,
    };
    // For napi an absent key and null mean the same (Option::None), but the optional
    // field types do not accept null — so we simply omit the key.
    if (this.#bodyLimit !== undefined) options.bodyLimit = this.#bodyLimit;
    this.#options = options;

    // Optional objects/Option fields are set only when present: napi rejects null.
    if (config.cors) options.cors = normalizeCors(config.cors);
    if (config.tls) options.tls = resolveTls(config.tls);
    if (config.h2c) options.h2c = true;
    if (config.headerReadTimeout != null) {
      options.headerReadTimeout = parseDuration(config.headerReadTimeout);
    }
    if (config.bodyReadTimeout != null) {
      options.bodyReadTimeout = parseDuration(config.bodyReadTimeout);
    }
    if (config.idleTimeout != null) options.idleTimeout = parseDuration(config.idleTimeout);
    if (config.handshakeTimeout != null) {
      options.handshakeTimeout = parseDuration(config.handshakeTimeout);
    }
    if (config.maxHeaders != null) options.maxHeaders = count('maxHeaders', config.maxHeaders);
    if (config.maxHeaderSize != null) options.maxHeaderSize = parseBytes(config.maxHeaderSize);
    if (config.shutdownTimeout != null) {
      options.shutdownTimeout = parseDuration(config.shutdownTimeout);
    }
    // The "readiness dropped but still accepting" pause — set 5–15s under k8s so the
    // balancer can drain traffic away before refusals start (§10 + §11).
    if (config.preShutdownDelay != null) {
      options.preShutdownDelay = parseDuration(config.preShutdownDelay);
    }
    // Socket options (§6c B9) and PROXY protocol (A4).
    if (config.backlog != null) options.backlog = count('backlog', config.backlog);
    if (config.reusePort != null) options.reusePort = config.reusePort;
    if (config.noDelay != null) options.noDelay = config.noDelay;
    if (config.maxConnections != null) {
      options.maxConnections = count('maxConnections', config.maxConnections);
    }
    if (config.proxyProtocol != null) options.proxyProtocol = config.proxyProtocol;
    // workerThreads: a number | 'auto' (from the cgroup quota). 'auto' = leave unset.
    if (typeof config.workerThreads === 'number') {
      options.workerThreads = count('workerThreads', config.workerThreads);
    } else if (config.workerThreads != null && config.workerThreads !== 'auto') {
      throw new TypeError("workerThreads: a number or 'auto'");
    }
    // Probes, metrics, access log (§11). An empty path disables the endpoint.
    if (config.health) {
      const h = config.health;
      if (h.path != null) options.healthPath = h.path;
      if (h.readyPath != null) options.readyPath = h.readyPath;
      if (h.metricsPath != null) options.metricsPath = h.metricsPath;
      if (h.port != null) options.adminPort = count('health.port', h.port);
    }
    if (config.accessLog != null) options.accessLog = config.accessLog;
    // Overload protection (§6c C5).
    if (config.maxConcurrentRequests != null) {
      options.maxConcurrentRequests = count('maxConcurrentRequests', config.maxConcurrentRequests);
    }
    if (config.maxQueue != null) options.maxQueue = count('maxQueue', config.maxQueue);
    if (config.queueTimeout != null) options.queueTimeout = parseDuration(config.queueTimeout);
    if (config.retryAfter != null) options.retryAfter = count('retryAfter', config.retryAfter);
    if (config.overloadShedAfter != null) {
      options.overloadShedAfter = parseDuration(config.overloadShedAfter);
    }
    // SIGTERM/SIGINT → graceful shutdown (§10). Disabled with { handleSignals: false }
    // — for example when an external supervisor already manages the process.
    this.#handleSignals = config.handleSignals !== false;
    this.#installSafetyNet = config.installSafetyNet !== false;
    this.#detectDisconnect = config.detectDisconnect === true;
    if (config.http2) options.http2 = normalizeHttp2(config.http2);
    this.#native = new RustServer();
  }

  // --- routes ---

  #add(method: string, path: string, args: unknown[]): this {
    // args: [options?, ...middleware, handler]
    const list = [...args];
    let hooks: Partial<Record<StageName, Array<Hook | ErrorHook>>> = {};
    let schema: RouteSchema | null = null;
    let multipart: NativeMultipartOptions | null = null;

    if (list.length > 1 && typeof list[0] === 'object' && list[0] !== null) {
      const opts = list.shift() as RouteOptions;
      hooks = normalizeRouteHooks(opts);
      schema = opts.schema ?? null;
      // `multipart: false` must stay off — it used to fall through to the normalizer and
      // switch multipart on with default limits.
      multipart =
        opts.multipart != null && opts.multipart !== false
          ? normalizeMultipart(opts.multipart)
          : null;
    }
    const handler = list.pop();
    if (typeof handler !== 'function') {
      throw new TypeError(`${method} ${path}: handler must be a function`);
    }
    this.#routes.push({
      method,
      path: join(this.#baseUrl, path),
      middleware: list as Middleware[], // route middleware (before the handler)
      hooks,
      schema, // { body?, query?, params?, response? } — valibot | JSON Schema
      multipart, // normalized multipart options | null
      handler: handler as Handler,
    });
    return this;
  }

  // The overloads exist for contextual typing: with a union-typed rest parameter TS
  // cannot infer `c` in the arrow and falls back to any — no autocomplete for users and
  // no checking in tests.
  get(path: string, handler: Handler): this;
  get(path: string, options: RouteOptions, handler: Handler): this;
  get(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this;
  get(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this {
    return this.#add('GET', path, a);
  }

  post(path: string, handler: Handler): this;
  post(path: string, options: RouteOptions, handler: Handler): this;
  post(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this;
  post(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this {
    return this.#add('POST', path, a);
  }

  put(path: string, handler: Handler): this;
  put(path: string, options: RouteOptions, handler: Handler): this;
  put(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this;
  put(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this {
    return this.#add('PUT', path, a);
  }

  patch(path: string, handler: Handler): this;
  patch(path: string, options: RouteOptions, handler: Handler): this;
  patch(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this;
  patch(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this {
    return this.#add('PATCH', path, a);
  }

  delete(path: string, handler: Handler): this;
  delete(path: string, options: RouteOptions, handler: Handler): this;
  delete(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this;
  delete(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this {
    return this.#add('DELETE', path, a);
  }

  head(path: string, handler: Handler): this;
  head(path: string, options: RouteOptions, handler: Handler): this;
  head(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this;
  head(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this {
    return this.#add('HEAD', path, a);
  }

  options(path: string, handler: Handler): this;
  options(path: string, options: RouteOptions, handler: Handler): this;
  options(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this;
  options(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this {
    return this.#add('OPTIONS', path, a);
  }

  all(path: string, handler: Handler): this;
  all(path: string, options: RouteOptions, handler: Handler): this;
  all(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this;
  all(path: string, ...a: Array<RouteOptions | Middleware | Handler>): this {
    return this.#add('ALL', path, a);
  }


  // --- middleware (the onion) ---

  /** `app.use(fn)` — global; `app.use(prefix, ...fns)` — scoped by prefix. */
  use(...args: Array<string | Middleware>): this {
    let prefix = this.#baseUrl;
    const list = [...args];
    if (typeof list[0] === 'string') {
      prefix = join(this.#baseUrl, normalizeBase(list.shift() as string));
    }
    for (const fn of list) {
      if (typeof fn !== 'function') throw new TypeError('use: middleware must be a function');
      this.#middleware.push({ prefix, fn });
    }
    return this;
  }

  // --- hooks ---

  /** Generic hook registration. */
  addHook(name: StageName, fn: Hook | ErrorHook): this {
    if (name === 'onError') return this.onError(fn as ErrorHook);
    if (!this.#hooks[name]) throw new TypeError(`unknown hook: ${name}`);
    if (typeof fn !== 'function') throw new TypeError(`${name}: handler must be a function`);
    this.#hooks[name].push({ prefix: this.#baseUrl, fn });
    return this;
  }

  /** The unified error handler `onError(err, c)`. Several may be registered. */
  onError(fn: ErrorHook): this {
    if (typeof fn !== 'function') throw new TypeError('onError: handler must be a function');
    this.#hooks.onError.push({ prefix: this.#baseUrl, fn });
    return this;
  }

  // Named hook methods. They used to be attached in a constructor loop — now they are
  // ordinary prototype methods: the types are visible and no 11 closures are allocated
  // per instance.
  onRequest(fn: Hook): this {
    return this.addHook('onRequest', fn);
  }
  preParsing(fn: Hook): this {
    return this.addHook('preParsing', fn);
  }
  preValidation(fn: Hook): this {
    return this.addHook('preValidation', fn);
  }
  preHandler(fn: Hook): this {
    return this.addHook('preHandler', fn);
  }
  preSerialization(fn: Hook): this {
    return this.addHook('preSerialization', fn);
  }
  onSend(fn: Hook): this {
    return this.addHook('onSend', fn);
  }
  onResponse(fn: Hook): this {
    return this.addHook('onResponse', fn);
  }
  onTimeout(fn: Hook): this {
    return this.addHook('onTimeout', fn);
  }
  onAbort(fn: Hook): this {
    return this.addHook('onAbort', fn);
  }

  // --- groups ---

  /** Mount a sub-application under a prefix (encapsulation via prefix matching).
   *
   *  The sub-app is recorded by reference and folded in at `listen()`, so routes,
   *  middleware and hooks added to it *after* this call are still picked up. Copying
   *  eagerly meant anything registered later was silently dropped. */
  route(prefix: string, sub: Server): this {
    if (!(sub instanceof Server)) {
      throw new TypeError('route(prefix, sub): sub must be a Server instance');
    }
    if (sub === this) throw new TypeError('route: a server cannot mount itself');
    this.#mounted.push({ prefix: join(this.#baseUrl, normalizeBase(prefix)), sub });
    return this;
  }

  /** Fold mounted sub-apps into this one. Recursive, so a sub-app may mount its own. */
  #applyMounts(): void {
    const mounts = this.#mounted;
    this.#mounted = []; // cleared first: a cycle would otherwise recurse forever
    for (const { prefix, sub } of mounts) {
      sub.#applyMounts();
      const remap = (pfx: string): string => (pfx === '' ? prefix : join(prefix, pfx));
      for (const m of sub.#middleware) this.#middleware.push({ prefix: remap(m.prefix), fn: m.fn });
      for (const stage of ALL_STAGES) {
        for (const h of sub.#hooks[stage]) {
          this.#hooks[stage].push({ prefix: remap(h.prefix), fn: h.fn });
        }
      }
      for (const r of sub.#routes) this.#routes.push({ ...r, path: join(prefix, r.path) });
    }
  }

  /** Custom 404 handler (otherwise Rust answers 404 without waking JS). */
  notFound(handler: Handler): this {
    this.#notFound = handler;
    return this;
  }

  // --- startup ---

  /** Listen on TCP (`{ port, host }`) or a Unix socket (`{ path }`) — §6c B9. */
  async listen({ port, host = '0.0.0.0', path }: ListenArgs = {}): Promise<this> {
    if (this.#closed) throw new Error('listen: server is closed (close() was already called)');
    if (this.#listening) throw new Error('listen: server is already listening');
    if (path != null) {
      if (typeof path !== 'string') throw new TypeError('listen: path must be a string');
      this.#options.unixPath = path;
      port = 0; // the native layer ignores the port when unixPath is set
    } else if (typeof port !== 'number') {
      throw new TypeError('listen: a numeric port or a path for a Unix socket is required');
    }
    if (this.#installSafetyNet) installSafetyNet();

    // Mounted sub-apps are folded in now, not at route() time, so late registrations
    // on them are included.
    this.#applyMounts();

    // Schemas: conversion to JSON Schema (for Rust) plus valibot preValidation injection.
    if (this.#routes.some((r) => r.schema != null)) await loadSchemaDeps();
    this.#responseStrip = this.#routes.map((r) => compileResponseStrip(r.schema));
    for (const r of this.#routes) injectValidation(r);

    // Precompile the chain for every route leaf.
    this.#chains = this.#routes.map((r) => buildChain(r, this.#middleware, this.#hooks));
    if (this.#notFound) {
      this.#notFoundChain = buildChain(
        { path: '', handler: this.#notFound, middleware: [], hooks: {} },
        this.#middleware,
        this.#hooks,
      );
    }

    const table: NativeRouteDef[] = this.#routes.map((r, i) => {
      const entry: NativeRouteDef = { method: r.method, path: r.path, leafId: i };
      if (r.schema) {
        const b = toJsonSchemaString(r.schema.body);
        const q = toJsonSchemaString(r.schema.query);
        const p = toJsonSchemaString(r.schema.params);
        if (b) entry.bodySchema = b;
        if (q) entry.querySchema = q;
        if (p) entry.paramsSchema = p;
      }
      if (r.multipart) entry.multipart = r.multipart;
      return entry;
    });

    try {
      this.#native.listen(
        port,
        host,
        table,
        this.#notFound != null,
        this.#options,
        // napi passes the (MatchedRequest, BodyIo) tuple as a single array argument.
        ([req, bodyIo]: [NativeRequest, BodyIo]) => this.#dispatch(req, bodyIo),
      );
    } catch (err) {
      // Bind fails synchronously (EADDRINUSE and friends) — we surface it both as an
      // event and as a reject. We emit only when a listener exists: an 'error' with no
      // subscriber brings the process down in EventEmitter, and our invariant is that
      // the process stays up (§8).
      if (this.#events.listenerCount('error') > 0) this.#events.emit('error', err);
      throw err;
    }

    this.#listening = true;
    if (this.#handleSignals) this.#installSignalHandlers();
    this.#events.emit('listening', path != null ? { path } : { port, host });
    return this;
  }

  /** Subscribe to server events: `listening`, `error`, `close`, `shutdown` (§6d B7). */
  on<E extends ServerEvent>(event: E, fn: ServerEventMap[E]): this {
    this.#events.on(event, fn as (...args: unknown[]) => void);
    return this;
  }
  off<E extends ServerEvent>(event: E, fn: ServerEventMap[E]): this {
    this.#events.off(event, fn as (...args: unknown[]) => void);
    return this;
  }

  /** Graceful shutdown (§10): close the listener, finish in-flight requests, then
   *  resolve. Idempotent and safe for concurrent calls — they all await the same drain. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      this.#events.emit('shutdown');
      // Readiness is dropped in Rust at the start of the drain; here we stop our timer
      // so it cannot flip the flag back mid-shutdown.
      this.#stopReadinessCheck();
      await this.#native.close();
      this.#listening = false;
      this.#closed = true;
      this.#removeSignalHandlers();
      this.#events.emit('close');
    })();
    return this.#closing;
  }

  get listening(): boolean {
    return this.#listening;
  }

  /** Socket-free test harness (§17): the request travels through an in-memory pipe and
   *  the very same pipeline — routing, schemas, CORS, metrics, the JS onion.
   *
   *  If the server is not started yet we start it on an ephemeral port (routes and
   *  schemas are compiled inside `listen()`); the request itself never uses a socket. */
  async inject(req: InjectRequest = {}): Promise<InjectResult> {
    const { method = 'GET', path = '/', headers = {}, body, query } = req;
    if (this.#closed) throw new Error('inject: server is closed (close() was already called)');
    await this.#ensureListening();

    let url = path;
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams(query).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }

    const pairs: KvPair[] = [];
    for (const [k, v] of Object.entries(headers)) {
      for (const one of Array.isArray(v) ? v : [v]) {
        const value = String(one);
        // A header value must fit into bytes (ByteString): a real HTTP client refuses
        // to send anything else, and the harness must behave the same way. Otherwise an
        // inject test passes while the same code fails over the network.
        const bad = [...value].findIndex((ch) => ch.codePointAt(0)! > 0xff);
        if (bad >= 0) {
          throw new TypeError(
            `inject: header "${k}" contains a character outside the byte range ` +
              `(position ${bad}); HTTP cannot carry that`,
          );
        }
        pairs.push({ key: k, value });
      }
    }

    let payload: Buffer | undefined;
    if (body != null) {
      if (Buffer.isBuffer(body)) payload = body;
      else if (typeof body === 'string') payload = Buffer.from(body);
      else {
        payload = Buffer.from(JSON.stringify(body));
        if (!pairs.some((p) => p.key.toLowerCase() === 'content-type')) {
          pairs.push({ key: 'content-type', value: 'application/json' });
        }
      }
    }

    const res = await this.#native.inject(method.toUpperCase(), url, pairs, payload);

    // Headers are exposed both as an object (convenient to assert on) and as a pair
    // list (set-cookie may repeat, and an object would collapse duplicates).
    const headerObj: Record<string, string> = {};
    for (const { key, value } of res.headers) {
      const prev = headerObj[key];
      headerObj[key] = prev !== undefined ? `${prev}, ${value}` : value;
    }

    return {
      status: res.status,
      headers: headerObj,
      rawHeaders: res.headers,
      body: res.body,
      text: () => res.body.toString('utf8'),
      json: <T = unknown,>(): T => JSON.parse(res.body.toString('utf8')) as T,
    };
  }

  /** Start the server for `inject()` if it is not running yet.
   *
   *  Concurrent cold injects must share one `listen()`. `listen()` suspends on
   *  `loadSchemaDeps()` when any route has a schema, so a plain `if (!listening) listen()`
   *  lets two callers both get past the check — and the second then trips the
   *  "already listening" guard. The in-flight promise is cleared once it settles, so a
   *  retry after a failed start still works. */
  async #ensureListening(): Promise<void> {
    if (this.#listening) return;
    this.#autostart ??= this.listen({ port: 0, host: '127.0.0.1' }).finally(() => {
      this.#autostart = null;
    });
    await this.#autostart;
  }

  /** Manual readiness (§11): `false` → `/readyz` returns 503; liveness is untouched. */
  setReady(ready: boolean): this {
    this.#native.setReady(Boolean(ready));
    return this;
  }

  /** Periodic readiness check (§11): database, queue, cache warm-up.
   *
   *  The callback runs on a timer on the JS side and pushes its verdict into Rust, while
   *  `/readyz` answers instantly from an atomic. Otherwise every k8s probe (once a second
   *  per pod) would wake the event loop — exactly what Rust-side probes exist to avoid.
   *  A callback error or timeout counts as "not ready". */
  setReadinessCheck(
    fn: () => boolean | void | Promise<boolean | void>,
    { interval = 2000, timeout = 1000 }: ReadinessCheckOptions = {},
  ): this {
    if (typeof fn !== 'function') throw new TypeError('setReadinessCheck: a function is required');
    this.#stopReadinessCheck();

    const tick = async (): Promise<void> => {
      let ok = false;
      let deadline: NodeJS.Timeout | undefined;
      try {
        const verdict = await Promise.race([
          Promise.resolve(fn()),
          new Promise<never>((_, rej) => {
            deadline = setTimeout(() => rej(new Error('timeout')), timeout);
            deadline.unref?.();
          }),
        ]);
        ok = verdict !== false; // undefined/anything non-false means ready
      } catch {
        ok = false; // threw or timed out — treat as not ready
      } finally {
        // Left dangling, this kept the process alive for up to `timeout` after close().
        if (deadline) clearTimeout(deadline);
      }
      if (this.#readinessTimer) this.setReady(ok);
    };

    this.#readinessTimer = setInterval(() => void tick(), interval);
    // The timer must not keep the process alive on its own.
    this.#readinessTimer.unref?.();
    void tick(); // run once immediately instead of waiting for the interval
    return this;
  }

  #stopReadinessCheck(): void {
    if (!this.#readinessTimer) return;
    clearInterval(this.#readinessTimer);
    this.#readinessTimer = null;
  }

  /** SIGTERM/SIGINT → graceful shutdown → exit 0 (k8s: §10). */
  #installSignalHandlers(): void {
    registerForSignals(this);
  }

  #removeSignalHandlers(): void {
    unregisterFromSignals(this);
  }

  async #dispatch(nreq: NativeRequest, bodyIo: BodyIo): Promise<NativeResponse> {
    const chain = nreq.leafId < 0 ? this.#notFoundChain : this.#chains[nreq.leafId];
    if (!chain) {
      // Unreachable: the route table and the chains are built from the same array.
      return { status: 500, headers: [], body: 'Internal Server Error' };
    }
    const c = buildContext(nreq, bodyIo, {
      baseUrl: this.#baseUrl,
      requestIdHeader: this.#requestIdHeader,
      bodyLimit: this.#bodyLimit,
      responseStrip: nreq.leafId < 0 ? null : (this.#responseStrip[nreq.leafId] ?? null),
    });

    const controller = new AbortController();
    c.req.signal = controller.signal;

    // Client-disconnect detection. Rust resolves this for every request (otherwise the
    // promise would leak on each successful one), so subscribing is only worth its cost
    // when something will act on the result.
    if (chain.onAbort.length > 0 || this.#detectDisconnect) {
      void bodyIo.waitAbort().then(
        async (aborted) => {
          if (!aborted || c._settled) return;
          c.aborted = true;
          controller.abort();
          try {
            await runAfterHooks(chain.onAbort, c);
          } catch {
            // The client is already gone — an onAbort failure has nowhere to surface.
          }
        },
        () => {
          // The native bridge went away; there is nothing left to report.
        },
      );
    }

    try {
      if (this.#requestTimeout) {
        await withTimeout(chain, c, this.#requestTimeout, controller);
      } else {
        await runCore(chain, c);
      }
      // "before write" hooks always run (short-circuit/normal/error/timeout).
      await runAfterHooks(chain.preSerialization, c);
      await runAfterHooks(chain.onSend, c);
    } catch (err) {
      // Last line of defence: an error in onSend/preSerialization → 500 (or the HttpError status).
      if (!c._finalized) {
        c._body = undefined;
        if (err instanceof HttpError) c.text(err.message || 'Error', err.status);
        else c.text('Internal Server Error', 500);
      }
    }

    const response = buildNativeResponse(c);

    // onResponse is observation only and always runs; its errors are swallowed.
    try {
      await runAfterHooks(chain.onResponse, c);
    } catch {
      // onResponse must not break the response
    }
    return response;
  }
}

const DEFAULT_CORS_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'];

/** Normalize config.cors into native CorsOptions (§6a).
 *  napi's Option<Vec> fields reject null → omit the key when unset. */
function normalizeCors(cors: CorsConfig): NativeCorsOptions {
  const origin = cors.origin ?? '*';
  const origins = Array.isArray(origin) ? origin : [origin];
  // Forbidden by the CORS spec and refused by browsers: the only way to honour it is to
  // reflect the caller's Origin, which lets any site make credentialed requests and read
  // the response. List the origins you actually trust instead.
  if (cors.credentials && origins.includes('*')) {
    throw new TypeError(
      "cors: origin '*' cannot be combined with credentials: true — " +
        'list the allowed origins explicitly',
    );
  }
  const out: NativeCorsOptions = {
    origins,
    methods: cors.methods ?? DEFAULT_CORS_METHODS,
    credentials: Boolean(cors.credentials),
  };
  // napi's Option<T> rejects null → set the key only when a value exists.
  if (cors.allowedHeaders) out.allowedHeaders = cors.allowedHeaders; // otherwise reflect requested
  if (cors.exposedHeaders) out.exposedHeaders = cors.exposedHeaders;
  if (cors.maxAge != null) out.maxAge = Math.floor(cors.maxAge);
  return out;
}

/** TLS resolution: path → read file, Buffer → string, PEM string as-is (§12). */
function resolveTls(tls: TlsConfig): { cert: string; key: string } {
  return { cert: resolvePem(tls.cert), key: resolvePem(tls.key) };
}
function resolvePem(v: string | Buffer): string {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'string') {
    return v.includes('-----BEGIN') ? v : fs.readFileSync(v, 'utf8');
  }
  throw new TypeError('tls cert/key: a string (PEM or path) or a Buffer');
}

/** Normalize config.http2 → native Http2Options (initialWindowSize accepts '1mb'). */
function normalizeHttp2(h: Http2Config): NativeHttp2Options {
  const out: NativeHttp2Options = {};
  if (h.maxConcurrentStreams != null) {
    out.maxConcurrentStreams = count('http2.maxConcurrentStreams', h.maxConcurrentStreams);
  }
  if (h.initialWindowSize != null) out.initialWindowSize = parseBytes(h.initialWindowSize);
  if (h.maxResetStreamsPerSec != null) {
    out.maxResetStreamsPerSec = count('http2.maxResetStreamsPerSec', h.maxResetStreamsPerSec);
  }
  return out;
}

/** Normalize the multipart option (`true` | `{...}`) into native MultipartOptions (§9a).
 *  `false` never reaches here — the caller keeps multipart off entirely. */
function normalizeMultipart(mp: true | MultipartConfig): NativeMultipartOptions {
  const o: MultipartConfig = mp === true ? {} : mp;
  const out: NativeMultipartOptions = {
    maxFileSize: parseBytes(o.maxFileSize ?? '50mb'),
    maxFieldSize: parseBytes(o.maxFieldSize ?? '1mb'),
    maxFiles: count('multipart.maxFiles', o.maxFiles ?? 10),
    maxFields: count('multipart.maxFields', o.maxFields ?? 100),
  };
  // napi's Option<Vec> rejects null → set the key only when provided.
  if (o.allowedMimeTypes) out.allowedMimeTypes = o.allowedMimeTypes;
  if (o.allowedExtensions) out.allowedExtensions = o.allowedExtensions;
  return out;
}

/** Build a status→Set(property names) map for response stripping by the response schema. */
function compileResponseStrip(schema: RouteSchema | null): ResponseStrip | null {
  if (!schema?.response) return null;
  const map: ResponseStrip = {};
  for (const [status, s] of Object.entries(schema.response)) {
    const props = topProps(s);
    if (props) map[status] = props;
  }
  return Object.keys(map).length ? map : null;
}

const VALIDATED_LOCATIONS = ['body', 'query', 'params'] as const;
const VALIDATION_ORDER = ['params', 'query', 'body'] as const;

/** Inject a synthetic preValidation hook for valibot transform/refine (§6b). */
function injectValidation(route: RouteEntry): void {
  const schema = route.schema;
  if (!schema) return;
  // listen() runs this over every route, and a retry after a failed bind (EADDRINUSE on
  // the first port choice) would otherwise prepend a second copy of the hook.
  if (route.validationInjected) return;

  const valibotSchemas: Partial<Record<(typeof VALIDATED_LOCATIONS)[number], ValibotSchema>> = {};
  for (const loc of VALIDATED_LOCATIONS) {
    const s: SchemaSource | undefined = schema[loc];
    if (isValibot(s)) valibotSchemas[loc] = s;
  }
  if (Object.keys(valibotSchemas).length === 0) return; // raw JSON Schema — no transform needed

  const hook: Hook = async (c: Context) => {
    for (const loc of VALIDATION_ORDER) {
      const vs = valibotSchemas[loc];
      if (!vs) continue;
      // Raw value: coerced by Rust, which now also decodes compressed bodies. The
      // c.req.json() branch is a safety net for a leaf Rust did not pre-validate.
      const raw =
        loc === 'body' && c.req._rustValid.body === undefined
          ? await c.req.json()
          : c.req._rustValid[loc];
      const res = valibotSafeParse(vs, raw);
      if (!res.success) {
        const issues: ValidationIssue[] = valibotIssues(res.issues ?? [], loc);
        c.json({ error: 'validation', issues }, 400);
        return; // short-circuit
      }
      c.req._valid[loc] = res.output; // the transform has been applied
    }
  };

  route.hooks = {
    ...route.hooks,
    preValidation: [hook, ...(route.hooks.preValidation ?? [])],
  };
  route.validationInjected = true;
}

/** Normalize route options `{onRequest:[...]|fn, preHandler, ...}` into `{stage:[fn]}`. */
function normalizeRouteHooks(opts: RouteOptions): Partial<Record<StageName, Hook[]>> {
  const hooks: Partial<Record<StageName, Hook[]>> = {};
  for (const stage of ALL_STAGES) {
    const v = opts[stage];
    if (v == null) continue;
    hooks[stage] = Array.isArray(v) ? v : [v];
  }
  return hooks;
}
