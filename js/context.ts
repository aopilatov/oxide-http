// Контекст `c` (§7) и финализация ответа. Заголовки — lowercase; `Set-Cookie`
// отдаётся отдельными строками; возврат значения из хендлера — сахар над c.json.
// Тело запроса/ответа — стриминг через BodyIo с backpressure (§9).

import zlib from 'node:zlib';

import type { SchemaSource } from './schema.ts';

// --- типы нативной границы (см. src/bridge.rs, src/stream.rs) ---

/** Пара ключ-значение на границе с Rust. */
export interface KvPair {
  key: string;
  value: string;
}

/** Метаданные части multipart из Rust. */
export interface PartMeta {
  name?: string | null;
  filename?: string | null;
  contentType?: string | null;
}

/** Мост тел запроса/ответа (napi-класс `BodyIo`). */
export interface BodyIo {
  read(): Promise<Buffer | null>;
  write(chunk: Buffer): Promise<void>;
  endWrite(): void;
  nextPart(): Promise<PartMeta | null>;
  readPart(): Promise<Buffer | null>;
}

/** Сматченный запрос, пришедший из Rust. */
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

/** Ответ, возвращаемый в Rust. */
export interface NativeResponse {
  status: number;
  headers: KvPair[];
  body?: string;
  streamed?: boolean;
}

// --- публичные типы контекста ---

/** Источник тела ответа для `c.body()`. */
export type BodySource = Buffer | Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<unknown>;

/** Опции `Set-Cookie` (§6d B1). */
export interface CookieOptions {
  maxAge?: number;
  domain?: string;
  path?: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none' | 'Strict' | 'Lax' | 'None';
}

/** Часть multipart-запроса (§9a). */
export interface MultipartPart {
  name: string | undefined;
  filename: string | undefined;
  contentType: string | undefined;
  readonly stream: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** Контекстный логгер (§6d B3). */
export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/** Где искать провалидированные значения. */
export type ValidLocation = 'body' | 'query' | 'params';

/** Запрос внутри контекста (§7). */
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
  /** AbortSignal запроса (таймаут/дисконнект) — проставляется диспетчером. */
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
  /** @internal значения из нативной валидации */
  _rustValid: Record<ValidLocation, unknown>;
  /** @internal результат valibot-transform поверх нативных */
  _valid: Record<string, unknown>;
}

/** Мутируемая часть ответа. */
export interface ContextResponse {
  status: number | undefined;
  headers: ResHeaders;
  sent: boolean;
}

/** Контекст запроса `c` (§7). */
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

/** Карта «статус → набор разрешённых полей» для стрипа ответа по схеме (§6b). */
export type ResponseStrip = Record<string | number, Set<string>>;

/** Опции построения контекста. */
export interface BuildContextOptions {
  baseUrl?: string;
  requestIdHeader?: string;
  bodyLimit?: number | undefined;
  responseStrip?: ResponseStrip | null;
}

/** Схемы маршрута (§6b). */
export interface RouteSchema {
  body?: SchemaSource;
  query?: SchemaSource;
  params?: SchemaSource;
  response?: Record<string | number, SchemaSource>;
}

/** Ошибка с HTTP-статусом (перехватывается диспетчером → отдаётся клиенту). */
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

/** Маркеры обрыва тела, приходящие из нативного read() (см. src/stream.rs). */
const messageOf = (e: unknown): string =>
  e != null && typeof e === 'object' && 'message' in e ? String((e as Error).message) : String(e);
const isLimitError = (e: unknown): boolean => e != null && /BODY_LIMIT_EXCEEDED/.test(messageOf(e));
const isReadTimeout = (e: unknown): boolean => e != null && /BODY_READ_TIMEOUT/.test(messageOf(e));

/** Прочитать чанк, маппя нативные маркеры в HttpError (413 / 408). */
async function readChunk(bodyIo: BodyIo): Promise<Buffer | null> {
  try {
    return await bodyIo.read();
  } catch (e) {
    if (isLimitError(e)) throw new HttpError(413, 'Payload Too Large');
    if (isReadTimeout(e)) throw new HttpError(408, 'Request Timeout');
    throw e;
  }
}

/** Прочитать всё тело запроса из BodyIo (backpressure per-chunk). Лимит — в Rust;
 *  здесь дублирующая проверка на случай, если нативный лимит выключен. */
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

/** Распаковать тело по Content-Encoding (§B5), лимит — на распакованный размер. */
function decompress(buf: Buffer, encoding: string | undefined, limit: number | undefined): Buffer {
  const enc = (encoding ?? '').trim().toLowerCase();
  if (!enc || enc === 'identity') return buf;
  const opts = limit != null ? { maxOutputLength: limit } : {};
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf, opts);
    if (enc === 'deflate') return zlib.inflateSync(buf, opts);
    if (enc === 'br') return zlib.brotliDecompressSync(buf, opts);
    return buf; // неизвестная кодировка — не трогаем
  } catch (e) {
    const code = e != null && typeof e === 'object' && 'code' in e ? String(e.code) : '';
    if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(messageOf(e))) {
      throw new HttpError(413, 'Payload Too Large');
    }
    throw new HttpError(400, 'Invalid compressed body');
  }
}

/** Web ReadableStream над телом запроса (pull → bodyIo.read). Превышение лимита
 *  (в Rust) → ошибка стрима с HttpError(413), которую поймает for-await хендлера. */
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

/** Прокачать источник (Buffer|ReadableStream|AsyncIterable) в BodyIo с backpressure. */
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
      // producer/соединение оборвались — просто закрываем тело.
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

// --- multipart (§9a): парсинг в Rust, здесь — итератор частей ---

/** Отклонение из Rust ("MULTIPART_REJECT:<status>:<msg>") → HttpError. */
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

/** Собрать объект-часть с потоком/буферизацией. */
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

/** Async-итератор частей multipart (потоково, §9a). */
async function* partsIterator(bodyIo: BodyIo): AsyncGenerator<MultipartPart, void, void> {
  for (;;) {
    const meta = await mpNextPart(bodyIo);
    if (meta == null) return;
    yield makePart(bodyIo, meta);
  }
}

/** Заголовки ответа: lowercase, set/append, несколько значений (set-cookie). */
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
  /** Плоский список пар (с повторами) для нативного слоя. */
  toPairs(): KvPair[] {
    const out: KvPair[] = [];
    for (const [key, arr] of this.#map) for (const value of arr) out.push({ key, value });
    return out;
  }
}

/** Разобрать заголовки запроса (Vec<KvPair>, уже lowercase) в map с join дублей. */
function buildReqHeaders(pairs: KvPair[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { key, value } of pairs) {
    const prev = map.get(key);
    map.set(key, prev !== undefined ? `${prev}, ${value}` : value);
  }
  return map;
}

/** Разобрать заголовок Cookie в объект `{ name: value }`. */
export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Сериализовать Set-Cookie (§6d B1). */
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

/** Контекстный логгер: структурный JSON в stdout с requestId (§6d B3). */
function makeLogger(requestId: string): Logger {
  const emit = (level: string, msg: string, extra?: Record<string, unknown>): void => {
    process.stdout.write(
      JSON.stringify({ level, time: new Date().toISOString(), requestId, msg, ...extra }) + '\n',
    );
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}

const CT_JSON = 'application/json; charset=utf-8';
const CT_TEXT = 'text/plain; charset=utf-8';

/** Построить контекст `c` из нативного запроса. */
export function buildContext(
  nreq: NativeRequest,
  bodyIo: BodyIo,
  {
    baseUrl = '',
    requestIdHeader = 'x-request-id',
    bodyLimit,
    responseStrip = null,
  }: BuildContextOptions = {},
): Context {
  const reqHeaders = buildReqHeaders(nreq.headers);

  // Провалидированные в Rust значения (JSON-строки) → объекты для c.req.valid().
  const rustValid: Record<ValidLocation, unknown> = {
    body: nreq.validBody != null ? JSON.parse(nreq.validBody) : undefined,
    query: nreq.validQuery != null ? JSON.parse(nreq.validQuery) : undefined,
    params: nreq.validParams != null ? JSON.parse(nreq.validParams) : undefined,
  };

  const rawPath = nreq.path;
  const path =
    baseUrl && rawPath.startsWith(baseUrl) ? rawPath.slice(baseUrl.length) || '/' : rawPath;
  const url = nreq.queryString ? `${rawPath}?${nreq.queryString}` : rawPath;

  const queryLast: Record<string, string> = Object.create(null) as Record<string, string>;
  const queryMulti: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const { key, value } of nreq.query) {
    queryLast[key] = value;
    (queryMulti[key] ??= []).push(value);
  }

  let cookies: Record<string, string> | undefined;

  // --- тело запроса (стриминг + буферизация с лимитом/декомпрессией) ---
  let bodyUsed = false;
  const useBody = (): void => {
    if (bodyUsed) throw new Error('тело запроса уже прочитано');
    bodyUsed = true;
  };
  const readBuffered = async (): Promise<Buffer> => {
    const raw = await collectRaw(bodyIo, bodyLimit);
    return decompress(raw, reqHeaders.get('content-encoding'), bodyLimit);
  };
  const arrayBuffer = async (): Promise<ArrayBuffer> => {
    useBody();
    const buf = await readBuffered();
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };
  const text = async (): Promise<string> => Buffer.from(await arrayBuffer()).toString('utf8');
  const parseBody = async (): Promise<Record<string, string>> =>
    Object.fromEntries(new URLSearchParams(await text()));

  const res: ContextResponse = { status: undefined, headers: new ResHeaders(), sent: false };
  // request-id пробрасываем в ответ по умолчанию (§6d B2).
  res.headers.set(requestIdHeader, nreq.id);

  const c: Context = {
    req: {
      method: nreq.method,
      path,
      rawPath,
      url,
      params: nreq.params,
      query: queryLast,
      queries: (k: string) => queryMulti[k] ?? [],
      header: (name: string) => reqHeaders.get(name.toLowerCase()),
      get headers(): Record<string, string> {
        return Object.fromEntries(reqHeaders);
      },
      ip: nreq.ip,
      ips: nreq.ips,
      country: nreq.country ?? undefined,
      id: nreq.id,
      signal: undefined, // AbortSignal (таймаут/дисконнект) — ставит диспетчер
      cookie: (name: string) => (cookies ??= parseCookies(reqHeaders.get('cookie')))[name],
      // тело
      get stream(): ReadableStream<Uint8Array> {
        useBody();
        return makeReqStream(bodyIo);
      },
      arrayBuffer,
      text,
      json: async <T = unknown,>(): Promise<T> => JSON.parse(await text()) as T,
      parseBody,
      // multipart: потоковый итератор частей (§9a)
      parts(): AsyncGenerator<MultipartPart, void, void> {
        useBody();
        return partsIterator(bodyIo);
      },
      formData: async (): Promise<FormData> => {
        const ct = reqHeaders.get('content-type') ?? '';
        const fd = new FormData();
        if (ct.startsWith('multipart/form-data')) {
          useBody();
          for await (const part of partsIterator(bodyIo)) {
            if (part.filename != null) {
              const buf = Buffer.from(await part.arrayBuffer());
              const opts = part.contentType ? { type: part.contentType } : {};
              fd.append(part.name ?? '', new Blob([buf], opts), part.filename);
            } else {
              fd.append(part.name ?? '', await part.text());
            }
          }
        } else {
          for (const [k, v] of new URLSearchParams(await text())) fd.append(k, v);
        }
        return fd;
      },
      // валидация (§6b): valibot-transform (_valid) поверх Rust-коэрции (_rustValid)
      _rustValid: rustValid,
      _valid: Object.create(null) as Record<string, unknown>,
      valid<T = unknown>(this: ContextRequest, loc: ValidLocation): T {
        return (this._valid[loc] !== undefined ? this._valid[loc] : this._rustValid[loc]) as T;
      },
    },
    res,
    _responseStrip: responseStrip,
    aborted: false, // true при дисконнекте/таймауте
    error: undefined, // последняя ошибка (для onError и «после»-хуков)
    _bodyIo: bodyIo,
    _body: undefined,
    _stream: undefined,
    _finalized: false,
    _settled: false, // ответ уже зафиксирован → мутаторы игнорируются
    log: makeLogger(nreq.id),

    // store между middleware/хендлером
    _store: new Map<string, unknown>(),
    set(k: string, v: unknown): Context {
      this._store.set(k, v);
      return this;
    },
    get<T = unknown>(k: string): T | undefined {
      return this._store.get(k) as T | undefined;
    },

    // мутаторы ответа (после фиксации ответа — no-op: защита от гонки таймаута)
    status(n: number): Context {
      if (!this._settled) res.status = n;
      return this;
    },
    header(k: string, v: string): Context {
      if (!this._settled) res.headers.set(k, v);
      return this;
    },
    cookie(name: string, value: string, opts?: CookieOptions): Context {
      if (!this._settled) res.headers.append('set-cookie', serializeCookie(name, value, opts));
      return this;
    },

    // финализирующие хелперы
    json(v: unknown, status?: number): Context {
      if (this._settled) return this;
      res.headers.set('content-type', CT_JSON);
      this._body = JSON.stringify(v);
      this._stream = undefined;
      if (status != null) res.status = status;
      this._finalized = true;
      return this;
    },
    text(v: string, status?: number): Context {
      if (this._settled) return this;
      res.headers.set('content-type', CT_TEXT);
      this._body = String(v);
      this._stream = undefined;
      if (status != null) res.status = status;
      this._finalized = true;
      return this;
    },
    body(data: BodySource | string | null | undefined, status?: number): Context {
      if (this._settled) return this;
      if (status != null) res.status = status;
      if (isStreamSource(data)) {
        this._stream = data; // Buffer/ReadableStream/AsyncIterable → стрим ответа
        this._body = undefined;
      } else {
        this._body = data == null ? undefined : String(data);
        this._stream = undefined;
      }
      this._finalized = true;
      return this;
    },
    redirect(location: string, status = 302): Context {
      return this.status(status).header('location', location).body('');
    },
    notFound(): Context {
      return this.text('Not Found', 404);
    },
  };

  return c;
}

/** Применить возврат-значение хендлера как сахар (string→text, stream→body, else json). */
export function applyReturnValue(c: Context, returnValue: unknown): void {
  if (!c._finalized && returnValue != null && returnValue !== c) {
    if (typeof returnValue === 'string') c.text(returnValue);
    else if (isStreamSource(returnValue)) c.body(returnValue);
    else c.json(returnValue);
  }
}

/** Свести контекст к нативному JsResponse (запускает pump для стрим-тела). */
export function buildNativeResponse(c: Context): NativeResponse {
  c._settled = true;
  c.res.sent = true;
  const status = c.res.status ?? 200;
  if (c._stream != null) {
    startResponsePump(c._bodyIo, c._stream);
    return { status, headers: c.res.headers.toPairs(), streamed: true };
  }
  // Стрип ответа по response-схеме: не утечёт то, чего нет в схеме (§6b).
  const body = stripResponse(c, status);
  // Ключ `body` ставим только когда тело есть: у нативного типа поле
  // опциональное, и явный undefined в него не пройдёт (exactOptionalPropertyTypes).
  const out: NativeResponse = { status, headers: c.res.headers.toPairs() };
  if (body !== undefined) out.body = body;
  return out;
}

/** Отсечь поля верхнего уровня, которых нет в response-схеме для статуса. */
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
