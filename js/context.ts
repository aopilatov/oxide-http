// The context `c` (§7) and response finalization. Headers are lowercase; `Set-Cookie`
// is emitted as separate lines; a value returned from a handler is sugar over c.json.
// Request/response bodies stream through BodyIo with backpressure (§9).

import zlib from 'node:zlib';

import type { SchemaSource } from './schema.ts';

// --- native boundary types (see src/bridge.rs, src/stream.rs) ---

/** Key-value pair on the Rust boundary. */
export interface KvPair {
  key: string;
  value: string;
}

/** Multipart part metadata coming from Rust. */
export interface PartMeta {
  name?: string | null;
  filename?: string | null;
  contentType?: string | null;
}

/** Request/response body bridge (the napi `BodyIo` class). */
export interface BodyIo {
  read(): Promise<Buffer | null>;
  write(chunk: Buffer): Promise<void>;
  endWrite(): void;
  nextPart(): Promise<PartMeta | null>;
  readPart(): Promise<Buffer | null>;
  /** Resolves when the request ends: `true` if the client disconnected first. */
  waitAbort(): Promise<boolean>;
}

/** A matched request received from Rust. */
export interface NativeRequest {
  leafId: number;
  method: string;
  path: string;
  queryString?: string | null;
  params: Record<string, string>;
  query: KvPair[];
  headers: KvPair[];
  ip: string;
  ips: string[];
  country?: string | null;
  id: string;
  validBody?: string | null;
  validQuery?: string | null;
  validParams?: string | null;
}

/** The response returned to Rust. */
export interface NativeResponse {
  status: number;
  headers: KvPair[];
  body?: string;
  streamed?: boolean;
}

// --- public context types ---

/** Response body source for `c.body()`. */
export type BodySource = Buffer | Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<unknown>;

/** `Set-Cookie` options (§6d B1). */
export interface CookieOptions {
  maxAge?: number;
  domain?: string;
  path?: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none' | 'Strict' | 'Lax' | 'None';
}

/** A part of a multipart request (§9a). */
export interface MultipartPart {
  name: string | undefined;
  filename: string | undefined;
  contentType: string | undefined;
  readonly stream: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** Contextual logger (§6d B3). */
export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/** Where to look for validated values. */
export type ValidLocation = 'body' | 'query' | 'params';

/** The request inside the context (§7). */
export interface ContextRequest {
  readonly method: string;
  readonly path: string;
  readonly rawPath: string;
  readonly url: string;
  readonly params: Record<string, string>;
  readonly query: Record<string, string>;
  queries(key: string): string[];
  header(name: string): string | undefined;
  readonly headers: Record<string, string>;
  readonly ip: string;
  readonly ips: string[];
  readonly country: string | undefined;
  readonly id: string;
  /** The request's AbortSignal (timeout/disconnect) — set by the dispatcher. */
  signal: AbortSignal | undefined;
  cookie(name: string): string | undefined;
  readonly stream: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  parseBody(): Promise<Record<string, string>>;
  parts(): AsyncGenerator<MultipartPart, void, void>;
  formData(): Promise<FormData>;
  valid<T = unknown>(loc: ValidLocation): T;
  /** @internal values from native validation */
  _rustValid: Record<ValidLocation, unknown>;
  /** @internal valibot transform result layered on the native values */
  _valid: Record<string, unknown>;
}

/** The mutable part of the response. */
export interface ContextResponse {
  status: number | undefined;
  headers: ResHeaders;
  sent: boolean;
}

/** The request context `c` (§7). */
export interface Context {
  readonly req: ContextRequest;
  readonly res: ContextResponse;
  aborted: boolean;
  error: unknown;
  readonly log: Logger;

  set(key: string, value: unknown): Context;
  get<T = unknown>(key: string): T | undefined;

  status(code: number): Context;
  header(name: string, value: string): Context;
  cookie(name: string, value: string, opts?: CookieOptions): Context;

  json(value: unknown, status?: number): Context;
  text(value: string, status?: number): Context;
  body(data: BodySource | string | null | undefined, status?: number): Context;
  redirect(location: string, status?: number): Context;
  notFound(): Context;

  /** @internal */ _responseStrip: ResponseStrip | null;
  /** @internal */ _bodyIo: BodyIo;
  /** @internal */ _body: string | undefined;
  /** @internal */ _stream: BodySource | undefined;
  /** @internal */ _finalized: boolean;
  /** @internal */ _settled: boolean;
  /** @internal */ _store: Map<string, unknown>;
}

/** Map of "status → allowed field set" for schema-based response stripping (§6b). */
export type ResponseStrip = Record<string | number, Set<string>>;

/** Context construction options. */
export interface BuildContextOptions {
  baseUrl?: string;
  requestIdHeader?: string;
  bodyLimit?: number | undefined;
  responseStrip?: ResponseStrip | null;
}

/** Route schemas (§6b). */
export interface RouteSchema {
  body?: SchemaSource;
  query?: SchemaSource;
  params?: SchemaSource;
  response?: Record<string | number, SchemaSource>;
}

/** An error carrying an HTTP status (caught by the dispatcher → sent to the client). */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

const toBuffer = (chunk: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  return Buffer.from(chunk as Uint8Array);
};

/** Body-abort markers coming from the native read() (see src/stream.rs). */
const messageOf = (e: unknown): string =>
  e != null && typeof e === 'object' && 'message' in e ? String((e as Error).message) : String(e);
const isLimitError = (e: unknown): boolean => e != null && /BODY_LIMIT_EXCEEDED/.test(messageOf(e));
const isReadTimeout = (e: unknown): boolean => e != null && /BODY_READ_TIMEOUT/.test(messageOf(e));
const isReadAborted = (e: unknown): boolean => e != null && /BODY_READ_ABORTED/.test(messageOf(e));

/** Read a chunk, mapping the native markers to HttpError (413 / 408 / 400). */
async function readChunk(bodyIo: BodyIo): Promise<Buffer | null> {
  try {
    return await bodyIo.read();
  } catch (e) {
    if (isLimitError(e)) throw new HttpError(413, 'Payload Too Large');
    if (isReadTimeout(e)) throw new HttpError(408, 'Request Timeout');
    // The connection died mid-body: surface it instead of returning a short buffer.
    if (isReadAborted(e)) throw new HttpError(400, 'Request body aborted');
    throw e;
  }
}

/** Read the entire request body from BodyIo (per-chunk backpressure). The limit is
 *  enforced in Rust; this is a duplicate check in case the native limit is off. */
async function collectRaw(bodyIo: BodyIo, limit: number | undefined): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = await readChunk(bodyIo);
    if (chunk == null) break;
    total += chunk.length;
    if (limit != null && total > limit) throw new HttpError(413, 'Payload Too Large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Decompress the body per Content-Encoding (§B5); the limit applies to the
 *  decompressed size. */
function decompress(buf: Buffer, encoding: string | undefined, limit: number | undefined): Buffer {
  const enc = (encoding ?? '').trim().toLowerCase();
  if (!enc || enc === 'identity') return buf;
  const opts = limit != null ? { maxOutputLength: limit } : {};
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, opts);
    if (enc === 'deflate') return zlib.inflateSync(buf, opts);
    if (enc === 'br') return zlib.brotliDecompressSync(buf, opts);
    // Passing an unknown encoding through just moved the failure to the parser, which
    // surfaced as a 500 for what is a client mistake.
    throw new HttpError(415, 'Unsupported Media Type');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const code = e != null && typeof e === 'object' && 'code' in e ? String(e.code) : '';
    if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(messageOf(e))) {
      throw new HttpError(413, 'Payload Too Large');
    }
    throw new HttpError(400, 'Invalid compressed body');
  }
}

/** A Web ReadableStream over the request body (pull → bodyIo.read). Exceeding the
 *  limit (in Rust) errors the stream with HttpError(413), caught by the handler's
 *  for-await. */
function makeReqStream(bodyIo: BodyIo): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await readChunk(bodyIo);
        if (chunk == null) controller.close();
        else controller.enqueue(new Uint8Array(chunk));
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/** Pump a source (Buffer|ReadableStream|AsyncIterable) into BodyIo with backpressure. */
function startResponsePump(bodyIo: BodyIo, source: BodySource): void {
  void (async () => {
    try {
      if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
        await bodyIo.write(toBuffer(source));
      } else if (typeof (source as ReadableStream<Uint8Array>).getReader === 'function') {
        const reader = (source as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value != null) await bodyIo.write(toBuffer(value));
        }
      } else if ((source as AsyncIterable<unknown>)[Symbol.asyncIterator] != null) {
        for await (const chunk of source as AsyncIterable<unknown>) {
          if (chunk != null) await bodyIo.write(toBuffer(chunk));
        }
      }
    } catch {
      // the producer/connection died — just close the body.
    } finally {
      bodyIo.endWrite();
    }
  })();
}

const isStreamSource = (v: unknown): v is BodySource => {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return true;
  if (v == null || typeof v !== 'object') return false;
  const o = v as Record<PropertyKey, unknown>;
  return typeof o['getReader'] === 'function' || o[Symbol.asyncIterator] != null;
};

// --- multipart (§9a): parsing happens in Rust; here we expose a part iterator ---

/** A rejection from Rust ("MULTIPART_REJECT:<status>:<msg>") → HttpError. */
function mpMapError(e: unknown): unknown {
  const m = /^MULTIPART_REJECT:(\d+):(.*)$/s.exec(messageOf(e));
  return m && m[1] !== undefined ? new HttpError(Number(m[1]), m[2]) : e;
}

async function mpNextPart(bodyIo: BodyIo): Promise<PartMeta | null> {
  try {
    return await bodyIo.nextPart();
  } catch (e) {
    throw mpMapError(e);
  }
}
async function mpReadPart(bodyIo: BodyIo): Promise<Buffer | null> {
  try {
    return await bodyIo.readPart();
  } catch (e) {
    throw mpMapError(e);
  }
}

/** Build a part object with streaming/buffering access. */
function makePart(bodyIo: BodyIo, meta: PartMeta): MultipartPart {
  const collect = async (): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for (;;) {
      const chunk = await mpReadPart(bodyIo);
      if (chunk == null) break;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  return {
    name: meta.name ?? undefined,
    filename: meta.filename ?? undefined,
    contentType: meta.contentType ?? undefined,
    get stream(): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await mpReadPart(bodyIo);
            if (chunk == null) controller.close();
            else controller.enqueue(new Uint8Array(chunk));
          } catch (e) {
            controller.error(e);
          }
        },
      });
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const b = await collect();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
    async text(): Promise<string> {
      return (await collect()).toString('utf8');
    },
  };
}

/** Async iterator over multipart parts (streaming, §9a). */
async function* partsIterator(bodyIo: BodyIo): AsyncGenerator<MultipartPart, void, void> {
  for (;;) {
    const meta = await mpNextPart(bodyIo);
    if (meta == null) return;
    yield makePart(bodyIo, meta);
  }
}

/** Response headers: lowercase, set/append, multiple values (set-cookie). */
export class ResHeaders {
  readonly #map = new Map<string, string[]>();

  set(name: string, value: string | number): this {
    this.#map.set(name.toLowerCase(), [String(value)]);
    return this;
  }
  append(name: string, value: string | number): this {
    const lk = name.toLowerCase();
    const arr = this.#map.get(lk) ?? [];
    arr.push(String(value));
    this.#map.set(lk, arr);
    return this;
  }
  get(name: string): string | undefined {
    return this.#map.get(name.toLowerCase())?.[0];
  }
  has(name: string): boolean {
    return this.#map.has(name.toLowerCase());
  }
  delete(name: string): this {
    this.#map.delete(name.toLowerCase());
    return this;
  }
  /** Flat list of pairs (duplicates allowed) for the native layer. */
  toPairs(): KvPair[] {
    const out: KvPair[] = [];
    for (const [key, arr] of this.#map) for (const value of arr) out.push({ key, value });
    return out;
  }
}

/** Parse request headers (Vec<KvPair>, already lowercase) into a map, joining duplicates.
 *
 *  `cookie` rejoins with `'; '`: RFC 9113 §8.2.3 lets HTTP/2 clients split the cookie
 *  header into several fields, and `', '` would make everything after the first cookie
 *  unparseable. */
function buildReqHeaders(pairs: KvPair[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { key, value } of pairs) {
    const prev = map.get(key);
    if (prev === undefined) {
      map.set(key, value);
    } else {
      map.set(key, `${prev}${key === 'cookie' ? '; ' : ', '}${value}`);
    }
  }
  return map;
}

/** Parse the Cookie header into a `{ name: value }` object. */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    // A malformed escape (`x=%zz`) makes decodeURIComponent throw. A bad cookie must not
    // take the whole request down with a 500 — keep the raw value instead.
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Serialize Set-Cookie (§6d B1). */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge != null) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.domain) s += `; Domain=${opts.domain}`;
  s += `; Path=${opts.path ?? '/'}`;
  if (opts.expires instanceof Date) s += `; Expires=${opts.expires.toUTCString()}`;
  if (opts.httpOnly) s += '; HttpOnly';
  if (opts.secure) s += '; Secure';
  if (opts.sameSite) {
    const v = String(opts.sameSite);
    s += `; SameSite=${v.slice(0, 1).toUpperCase()}${v.slice(1).toLowerCase()}`;
  }
  return s;
}

/** Contextual logger: structured JSON to stdout carrying requestId (§6d B3). */
class ReqLogger implements Logger {
  readonly #requestId: string;

  constructor(requestId: string) {
    this.#requestId = requestId;
  }

  #emit(level: string, msg: string, extra?: Record<string, unknown>): void {
    process.stdout.write(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        requestId: this.#requestId,
        msg,
        ...extra,
      }) + '\n',
    );
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.#emit('debug', msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>): void {
    this.#emit('info', msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>): void {
    this.#emit('warn', msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>): void {
    this.#emit('error', msg, extra);
  }
}

const CT_JSON = 'application/json; charset=utf-8';
const CT_TEXT = 'text/plain; charset=utf-8';

/** The request side of `c`: methods live on the prototype, per-request state in fields.
 *  Derived views (header map, query records, cookies, valid values) are built on first
 *  access — a handler that never touches them pays nothing (§17). */
class OxideRequest implements ContextRequest {
  readonly #nreq: NativeRequest;
  readonly #bodyIo: BodyIo;
  readonly #baseUrl: string;
  readonly #bodyLimit: number | undefined;
  #path: string | undefined;
  #headers: Map<string, string> | undefined;
  #queryLast: Record<string, string> | undefined;
  #queryMulti: Record<string, string[]> | undefined;
  #cookies: Record<string, string> | undefined;
  #bodyUsed = false;
  #signal: AbortSignal | undefined;
  #rustValid: Record<ValidLocation, unknown> | undefined;
  #valid: Record<string, unknown> | undefined;

  constructor(
    nreq: NativeRequest,
    bodyIo: BodyIo,
    baseUrl: string,
    bodyLimit: number | undefined,
  ) {
    this.#nreq = nreq;
    this.#bodyIo = bodyIo;
    this.#baseUrl = baseUrl;
    this.#bodyLimit = bodyLimit;
  }

  get method(): string {
    return this.#nreq.method;
  }
  get rawPath(): string {
    return this.#nreq.path;
  }
  get path(): string {
    if (this.#path === undefined) {
      const raw = this.#nreq.path;
      const base = this.#baseUrl;
      this.#path = base && raw.startsWith(base) ? raw.slice(base.length) || '/' : raw;
    }
    return this.#path;
  }
  get url(): string {
    const qs = this.#nreq.queryString;
    return qs ? `${this.#nreq.path}?${qs}` : this.#nreq.path;
  }
  get params(): Record<string, string> {
    return this.#nreq.params;
  }

  get query(): Record<string, string> {
    if (this.#queryLast === undefined) {
      const last: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const { key, value } of this.#nreq.query) last[key] = value;
      this.#queryLast = last;
    }
    return this.#queryLast;
  }
  queries(key: string): string[] {
    if (this.#queryMulti === undefined) {
      const multi: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
      for (const { key: k, value } of this.#nreq.query) (multi[k] ??= []).push(value);
      this.#queryMulti = multi;
    }
    return this.#queryMulti[key] ?? [];
  }

  #headersMap(): Map<string, string> {
    return (this.#headers ??= buildReqHeaders(this.#nreq.headers));
  }
  header(name: string): string | undefined {
    return this.#headersMap().get(name.toLowerCase());
  }
  get headers(): Record<string, string> {
    return Object.fromEntries(this.#headersMap());
  }

  get ip(): string {
    return this.#nreq.ip;
  }
  get ips(): string[] {
    return this.#nreq.ips;
  }
  get country(): string | undefined {
    return this.#nreq.country ?? undefined;
  }
  get id(): string {
    return this.#nreq.id;
  }

  /** The dispatcher installs its controller's signal when a timeout or disconnect
   *  watcher exists; otherwise the first reader gets an inert (never aborted) signal. */
  get signal(): AbortSignal | undefined {
    return (this.#signal ??= new AbortController().signal);
  }
  set signal(s: AbortSignal | undefined) {
    this.#signal = s;
  }

  cookie(name: string): string | undefined {
    return (this.#cookies ??= parseCookies(this.header('cookie')))[name];
  }

  // --- body (streaming plus buffering with limit/decompression) ---
  #useBody(): void {
    if (this.#bodyUsed) throw new Error('request body has already been read');
    this.#bodyUsed = true;
  }
  get stream(): ReadableStream<Uint8Array> {
    this.#useBody();
    return makeReqStream(this.#bodyIo);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    this.#useBody();
    const raw = await collectRaw(this.#bodyIo, this.#bodyLimit);
    // Uniform: the channel always carries what the client sent, schema or not.
    const buf = decompress(raw, this.header('content-encoding'), this.#bodyLimit);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  async text(): Promise<string> {
    return Buffer.from(await this.arrayBuffer()).toString('utf8');
  }
  // Malformed JSON is a client mistake: 400, not the 500 a bare SyntaxError produced.
  async json<T = unknown>(): Promise<T> {
    const raw = await this.text();
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
  }
  async parseBody(): Promise<Record<string, string>> {
    return Object.fromEntries(new URLSearchParams(await this.text()));
  }
  // multipart: streaming iterator over parts (§9a)
  parts(): AsyncGenerator<MultipartPart, void, void> {
    this.#useBody();
    return partsIterator(this.#bodyIo);
  }
  async formData(): Promise<FormData> {
    const ct = this.header('content-type') ?? '';
    const fd = new FormData();
    if (ct.startsWith('multipart/form-data')) {
      this.#useBody();
      for await (const part of partsIterator(this.#bodyIo)) {
        if (part.filename != null) {
          const buf = Buffer.from(await part.arrayBuffer());
          const opts = part.contentType ? { type: part.contentType } : {};
          fd.append(part.name ?? '', new Blob([buf], opts), part.filename);
        } else {
          fd.append(part.name ?? '', await part.text());
        }
      }
    } else {
      for (const [k, v] of new URLSearchParams(await this.text())) fd.append(k, v);
    }
    return fd;
  }

  // validation (§6b): the valibot transform (_valid) layered on Rust coercion (_rustValid)
  get _rustValid(): Record<ValidLocation, unknown> {
    // Values validated in Rust (JSON strings) → objects for c.req.valid().
    return (this.#rustValid ??= {
      body: this.#nreq.validBody != null ? JSON.parse(this.#nreq.validBody) : undefined,
      query: this.#nreq.validQuery != null ? JSON.parse(this.#nreq.validQuery) : undefined,
      params: this.#nreq.validParams != null ? JSON.parse(this.#nreq.validParams) : undefined,
    });
  }
  get _valid(): Record<string, unknown> {
    return (this.#valid ??= Object.create(null) as Record<string, unknown>);
  }
  valid<T = unknown>(loc: ValidLocation): T {
    const transformed = this.#valid?.[loc];
    return (transformed !== undefined ? transformed : this._rustValid[loc]) as T;
  }
}

/** The mutable response side. ResHeaders (with the request-id echo, §6d B2) is created
 *  on first touch, so an untouched response pays for it only at finalize time. */
class OxideResponse implements ContextResponse {
  status: number | undefined = undefined;
  sent = false;
  #headers: ResHeaders | undefined;
  readonly #requestIdHeader: string;
  readonly #requestId: string;

  constructor(requestIdHeader: string, requestId: string) {
    this.#requestIdHeader = requestIdHeader;
    this.#requestId = requestId;
  }

  get headers(): ResHeaders {
    // request-id is echoed into the response by default (§6d B2).
    return (this.#headers ??= new ResHeaders().set(this.#requestIdHeader, this.#requestId));
  }
}

/** The context `c`: prototype methods, lazy store and logger. */
class OxideContext implements Context {
  readonly req: OxideRequest;
  readonly res: OxideResponse;
  aborted = false; // true on disconnect/timeout
  error: unknown = undefined; // the last error (for onError and the "after" hooks)
  _responseStrip: ResponseStrip | null;
  _bodyIo: BodyIo;
  _body: string | undefined = undefined;
  _stream: BodySource | undefined = undefined;
  _finalized = false;
  _settled = false; // the response is already fixed → mutators are ignored
  #store: Map<string, unknown> | undefined;
  #log: Logger | undefined;

  constructor(nreq: NativeRequest, bodyIo: BodyIo, opts: BuildContextOptions) {
    this.req = new OxideRequest(nreq, bodyIo, opts.baseUrl ?? '', opts.bodyLimit);
    this.res = new OxideResponse(opts.requestIdHeader ?? 'x-request-id', nreq.id);
    this._responseStrip = opts.responseStrip ?? null;
    this._bodyIo = bodyIo;
  }

  get log(): Logger {
    return (this.#log ??= new ReqLogger(this.req.id));
  }

  // store shared between middleware and the handler
  get _store(): Map<string, unknown> {
    return (this.#store ??= new Map<string, unknown>());
  }
  set(key: string, value: unknown): Context {
    this._store.set(key, value);
    return this;
  }
  get<T = unknown>(key: string): T | undefined {
    return this.#store?.get(key) as T | undefined;
  }

  // response mutators (no-ops once the response is fixed: guards the timeout race)
  status(code: number): Context {
    if (!this._settled) this.res.status = code;
    return this;
  }
  header(name: string, value: string): Context {
    if (!this._settled) this.res.headers.set(name, value);
    return this;
  }
  cookie(name: string, value: string, opts?: CookieOptions): Context {
    if (!this._settled) this.res.headers.append('set-cookie', serializeCookie(name, value, opts));
    return this;
  }

  // finalizing helpers
  json(value: unknown, status?: number): Context {
    if (this._settled) return this;
    this.res.headers.set('content-type', CT_JSON);
    this._body = JSON.stringify(value);
    this._stream = undefined;
    if (status != null) this.res.status = status;
    this._finalized = true;
    return this;
  }
  text(value: string, status?: number): Context {
    if (this._settled) return this;
    this.res.headers.set('content-type', CT_TEXT);
    this._body = String(value);
    this._stream = undefined;
    if (status != null) this.res.status = status;
    this._finalized = true;
    return this;
  }
  body(data: BodySource | string | null | undefined, status?: number): Context {
    if (this._settled) return this;
    if (status != null) this.res.status = status;
    if (isStreamSource(data)) {
      this._stream = data; // Buffer/ReadableStream/AsyncIterable → streamed response
      this._body = undefined;
    } else {
      this._body = data == null ? undefined : String(data);
      this._stream = undefined;
    }
    this._finalized = true;
    return this;
  }
  redirect(location: string, status = 302): Context {
    return this.status(status).header('location', location).body('');
  }
  notFound(): Context {
    return this.text('Not Found', 404);
  }
}

/** Build the context `c` from a native request. */
export function buildContext(
  nreq: NativeRequest,
  bodyIo: BodyIo,
  opts: BuildContextOptions = {},
): Context {
  return new OxideContext(nreq, bodyIo, opts);
}

/** Apply the handler's return value as sugar (string→text, stream→body, else json). */
export function applyReturnValue(c: Context, returnValue: unknown): void {
  if (!c._finalized && returnValue != null && returnValue !== c) {
    if (typeof returnValue === 'string') c.text(returnValue);
    else if (isStreamSource(returnValue)) c.body(returnValue);
    else c.json(returnValue);
  }
}

/** Reduce the context to a native JsResponse (starts the pump for a streamed body). */
export function buildNativeResponse(c: Context): NativeResponse {
  c._settled = true;
  c.res.sent = true;
  const status = c.res.status ?? 200;
  if (c._stream != null) {
    startResponsePump(c._bodyIo, c._stream);
    return { status, headers: c.res.headers.toPairs(), streamed: true };
  }
  // Response stripping by the response schema: nothing outside the schema leaks (§6b).
  const body = stripResponse(c, status);
  // The `body` key is set only when a body exists: the native type declares it optional
  // and an explicit undefined would not pass (exactOptionalPropertyTypes).
  const out: NativeResponse = { status, headers: c.res.headers.toPairs() };
  if (body !== undefined) out.body = body;
  return out;
}

/** Strip top-level fields absent from the response schema for this status. */
function stripResponse(c: Context, status: number): string | undefined {
  const strip = c._responseStrip;
  if (!strip || c._body == null) return c._body;
  const props = strip[status] ?? strip[String(status)];
  if (!props) return c._body;
  const ct = c.res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return c._body;
  try {
    const parsed: unknown = JSON.parse(c._body);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return c._body;
    const src = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) if (props.has(k)) out[k] = src[k];
    return JSON.stringify(out);
  } catch {
    return c._body;
  }
}
