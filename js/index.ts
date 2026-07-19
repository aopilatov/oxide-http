// Публичная обёртка над нативным `RustServer`. Регистрация маршрутов,
// middleware (луковица) и хуков жизненного цикла; роутинг/матчинг/404/405 — в Rust.
// Цепочки предкомпилируются на listen() (см. pipeline.ts), контекст — context.ts.

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

// --- публичные типы конфигурации ---

/** CORS (§6a). `origin`-функция не нативна — для динамики пишите JS-middleware. */
export interface CorsConfig {
  origin?: string | string[];
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/** TLS (§12): PEM-строка, путь к файлу либо Buffer. */
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

/** Пробы и метрики (§11). Пустая строка в пути = ручка выключена. */
export interface HealthConfig {
  path?: string;
  readyPath?: string;
  metricsPath?: string;
  /** Отдельный порт: тогда на основном порту проб и метрик нет. */
  port?: number;
}

/** Лимиты multipart (§9a). */
export interface MultipartConfig {
  maxFileSize?: ByteSize;
  maxFieldSize?: ByteSize;
  maxFiles?: number;
  maxFields?: number;
  allowedMimeTypes?: string[];
  allowedExtensions?: string[];
}

/** Конфигурация сервера. */
export interface ServerConfig {
  baseUrl?: string;
  requestId?: { header?: string };
  bodyLimit?: ByteSize;
  requestTimeout?: Duration;
  customIpHeaders?: string[];
  customCountryHeaders?: string[];
  cors?: CorsConfig;
  tls?: TlsConfig;
  /** h2c prior-knowledge на plaintext-порту (§12). */
  h2c?: boolean;
  http2?: Http2Config;
  // таймауты (§6c A2)
  headerReadTimeout?: Duration;
  bodyReadTimeout?: Duration;
  idleTimeout?: Duration;
  handshakeTimeout?: Duration;
  maxHeaders?: number;
  maxHeaderSize?: ByteSize;
  // жизненный цикл (§10)
  shutdownTimeout?: Duration;
  /** Пауза «readiness снят, но ещё принимаем» — под k8s 5–15с. */
  preShutdownDelay?: Duration;
  handleSignals?: boolean;
  // сеть и платформа (§6c B9, A3, A4)
  backlog?: number;
  reusePort?: boolean;
  noDelay?: boolean;
  maxConnections?: number;
  proxyProtocol?: boolean;
  workerThreads?: number | 'auto';
  // наблюдаемость (§11)
  health?: HealthConfig;
  accessLog?: boolean;
  // перегрузка (§6c C5)
  maxConcurrentRequests?: number;
  maxQueue?: number;
  queueTimeout?: Duration;
  retryAfter?: number;
  overloadShedAfter?: Duration;
}

/** Опции маршрута: схемы, multipart и маршрутные хуки. */
export type RouteOptions = {
  schema?: RouteSchema;
  multipart?: boolean | MultipartConfig;
} & Partial<Record<StageName, Hook | Hook[]>>;

/** Аргументы `listen()`: TCP либо Unix-сокет. */
export interface ListenArgs {
  port?: number;
  host?: string;
  /** Unix-сокет (§6c B9); задан → `port`/`host` игнорируются. */
  path?: string;
}

/** Запрос для `app.inject()` (§17). */
export interface InjectRequest {
  method?: string;
  path?: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer | string | unknown;
  query?: Record<string, string>;
}

/** Ответ `app.inject()`. */
export interface InjectResult {
  status: number;
  headers: Record<string, string>;
  rawHeaders: KvPair[];
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

/** События сервера (§6d B7). */
export type ServerEvent = 'listening' | 'error' | 'close' | 'shutdown';

/** Полезная нагрузка события `listening`: TCP-адрес либо путь Unix-сокета. */
export interface ListeningInfo {
  port?: number;
  host?: string;
  path?: string;
}

/** Сигнатуры обработчиков по событию. */
export interface ServerEventMap {
  listening: (info: ListeningInfo) => void;
  error: (err: unknown) => void;
  close: () => void;
  shutdown: () => void;
}

/** Опции периодической проверки готовности (§11). */
export interface ReadinessCheckOptions {
  interval?: number;
  timeout?: number;
}

// --- внутренние типы ---

interface RouteEntry {
  method: string;
  path: string;
  middleware: Middleware[];
  hooks: Partial<Record<StageName, Array<Hook | ErrorHook>>>;
  schema: RouteSchema | null;
  multipart: NativeMultipartOptions | null;
  handler: Handler;
}

type HooksByStage = Record<StageName, Array<Scoped<Hook | ErrorHook>>>;

// Страховочный process-level хендлер (§8): в норме не срабатывает — срабатывание
// означает баг обёртки (не пойманный reject). Логируем, но процесс НЕ роняем.
let safetyNetInstalled = false;
function installSafetyNet(): void {
  if (safetyNetInstalled) return;
  safetyNetInstalled = true;
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        msg: 'unhandledRejection (баг обёртки @oxide-ts/http — процесс не падает)',
        reason: reason instanceof Error ? reason.stack : String(reason),
      }) + '\n',
    );
  });
}

/** Нормализация префикса: '' | '/' → ''; ведущий слэш обяз.; хвостовой (и /*) убираем. */
function normalizeBase(b: string | undefined): string {
  if (!b || b === '/') return '';
  let s = b.startsWith('/') ? b : '/' + b;
  if (s.endsWith('/*')) s = s.slice(0, -2);
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s || '';
}

/** Склейка префикса и пути маршрута (path === '/' не даёт двойного слэша). */
function join(base: string, path: string): string {
  const p = path.startsWith('/') ? path : '/' + path;
  if (p === '/') return base === '' ? '/' : base;
  return base + p;
}

/** Пустой набор хуков по стадиям. */
function emptyHooks(): HooksByStage {
  const h = {} as HooksByStage;
  for (const stage of ALL_STAGES) h[stage] = [];
  return h;
}

export class Server {
  readonly #native: RustServer;
  #routes: RouteEntry[] = [];
  #middleware: Array<Scoped<Middleware>> = []; // луковица (глобальные + префиксные)
  #hooks: HooksByStage = emptyHooks();
  #baseUrl = '';
  #notFound: Handler | null = null;
  #chains: Chain[] = []; // предкомпилированные цепочки по leafId (после listen)
  #notFoundChain: Chain | null = null;
  #responseStrip: Array<ResponseStrip | null> = []; // по leafId
  #options: NativeListenOptions;
  #requestIdHeader: string;
  #bodyLimit: number | undefined;
  #requestTimeout: number | null;
  #events = new EventEmitter();
  #listening = false;
  #closing: Promise<void> | null = null; // делает close() идемпотентным
  #signalCleanup: (() => void) | null = null;
  #handleSignals: boolean;
  #readinessTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(config: ServerConfig = {}) {
    this.#baseUrl = normalizeBase(config.baseUrl);
    this.#requestIdHeader = (config.requestId?.header ?? 'x-request-id').toLowerCase();
    this.#bodyLimit = parseBytes(config.bodyLimit ?? '10mb');
    this.#requestTimeout =
      config.requestTimeout != null ? (parseDuration(config.requestTimeout) ?? null) : null;

    const options: NativeListenOptions = {
      customIpHeaders: config.customIpHeaders ?? [],
      customCountryHeaders: config.customCountryHeaders ?? [],
      requestIdHeader: this.#requestIdHeader,
    };
    // Отсутствие ключа и null для napi одинаковы (Option::None), но типы
    // опциональных полей null не принимают — просто не задаём ключ.
    if (this.#bodyLimit !== undefined) options.bodyLimit = this.#bodyLimit;
    this.#options = options;

    // Опциональные объекты/Option-поля задаём только когда есть: napi не принимает null.
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
    if (config.maxHeaders != null) options.maxHeaders = config.maxHeaders;
    if (config.maxHeaderSize != null) options.maxHeaderSize = parseBytes(config.maxHeaderSize);
    if (config.shutdownTimeout != null) {
      options.shutdownTimeout = parseDuration(config.shutdownTimeout);
    }
    // Пауза «readiness снят, но ещё принимаем» — под k8s ставить 5–15с, чтобы
    // балансировщик успел увести трафик до отказа в соединениях (§10 + §11).
    if (config.preShutdownDelay != null) {
      options.preShutdownDelay = parseDuration(config.preShutdownDelay);
    }
    // Socket-опции (§6c B9) и PROXY protocol (A4).
    if (config.backlog != null) options.backlog = config.backlog;
    if (config.reusePort != null) options.reusePort = config.reusePort;
    if (config.noDelay != null) options.noDelay = config.noDelay;
    if (config.maxConnections != null) options.maxConnections = config.maxConnections;
    if (config.proxyProtocol != null) options.proxyProtocol = config.proxyProtocol;
    // workerThreads: число | 'auto' (по cgroup-квоте). 'auto' = не задавать явно.
    if (typeof config.workerThreads === 'number') {
      options.workerThreads = config.workerThreads;
    } else if (config.workerThreads != null && config.workerThreads !== 'auto') {
      throw new TypeError("workerThreads: число либо 'auto'");
    }
    // Пробы, метрики, access-log (§11). Пустая строка в пути = ручка выключена.
    if (config.health) {
      const h = config.health;
      if (h.path != null) options.healthPath = h.path;
      if (h.readyPath != null) options.readyPath = h.readyPath;
      if (h.metricsPath != null) options.metricsPath = h.metricsPath;
      if (h.port != null) options.adminPort = h.port;
    }
    if (config.accessLog != null) options.accessLog = config.accessLog;
    // Защита от перегрузки (§6c C5).
    if (config.maxConcurrentRequests != null) {
      options.maxConcurrentRequests = config.maxConcurrentRequests;
    }
    if (config.maxQueue != null) options.maxQueue = config.maxQueue;
    if (config.queueTimeout != null) options.queueTimeout = parseDuration(config.queueTimeout);
    if (config.retryAfter != null) options.retryAfter = config.retryAfter;
    if (config.overloadShedAfter != null) {
      options.overloadShedAfter = parseDuration(config.overloadShedAfter);
    }
    // SIGTERM/SIGINT → graceful shutdown (§10). Выключается { handleSignals: false }
    // — например когда процессом уже управляет внешний супервизор.
    this.#handleSignals = config.handleSignals !== false;
    if (config.http2) options.http2 = normalizeHttp2(config.http2);
    this.#native = new RustServer();
  }

  // --- маршруты ---

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
      multipart = opts.multipart != null ? normalizeMultipart(opts.multipart) : null;
    }
    const handler = list.pop();
    if (typeof handler !== 'function') {
      throw new TypeError(`${method} ${path}: хендлер должен быть функцией`);
    }
    this.#routes.push({
      method,
      path: join(this.#baseUrl, path),
      middleware: list as Middleware[], // маршрутные middleware (перед хендлером)
      hooks,
      schema, // { body?, query?, params?, response? } — valibot | JSON Schema
      multipart, // нормализованные опции multipart | null
      handler: handler as Handler,
    });
    return this;
  }

  // Перегрузки нужны для контекстной типизации: при rest-параметре с
  // объединением типов TS не может вывести `c` в стрелке и подставляет any —
  // ни автодополнения у пользователя, ни проверки в тестах.
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


  // --- middleware (луковица) ---

  /** `app.use(fn)` — глобальный; `app.use(prefix, ...fns)` — по префиксу. */
  use(...args: Array<string | Middleware>): this {
    let prefix = this.#baseUrl;
    const list = [...args];
    if (typeof list[0] === 'string') {
      prefix = join(this.#baseUrl, normalizeBase(list.shift() as string));
    }
    for (const fn of list) {
      if (typeof fn !== 'function') throw new TypeError('use: middleware должен быть функцией');
      this.#middleware.push({ prefix, fn });
    }
    return this;
  }

  // --- хуки ---

  /** Обобщённая регистрация хука. */
  addHook(name: StageName, fn: Hook | ErrorHook): this {
    if (name === 'onError') return this.onError(fn as ErrorHook);
    if (!this.#hooks[name]) throw new TypeError(`неизвестный хук: ${name}`);
    if (typeof fn !== 'function') throw new TypeError(`${name}: обработчик должен быть функцией`);
    this.#hooks[name].push({ prefix: this.#baseUrl, fn });
    return this;
  }

  /** Единый обработчик ошибок `onError(err, c)`. Можно навесить несколько. */
  onError(fn: ErrorHook): this {
    if (typeof fn !== 'function') throw new TypeError('onError: обработчик должен быть функцией');
    this.#hooks.onError.push({ prefix: this.#baseUrl, fn });
    return this;
  }

  // Именованные методы-хуки. Раньше навешивались циклом в конструкторе — теперь
  // это обычные методы прототипа: и типы видны, и на каждый экземпляр не
  // создаётся по 11 замыканий.
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
  onConnect(fn: Hook): this {
    return this.addHook('onConnect', fn);
  }
  onClose(fn: Hook): this {
    return this.addHook('onClose', fn);
  }

  // --- группы ---

  /** Смонтировать суб-приложение под префиксом (инкапсуляция через префикс-матчинг). */
  route(prefix: string, sub: Server): this {
    if (!(sub instanceof Server)) {
      throw new TypeError('route(prefix, sub): sub должен быть экземпляром Server');
    }
    const P = join(this.#baseUrl, normalizeBase(prefix));
    const remap = (pfx: string): string => (pfx === '' ? P : join(P, pfx));

    for (const m of sub.#middleware) this.#middleware.push({ prefix: remap(m.prefix), fn: m.fn });
    for (const stage of ALL_STAGES) {
      for (const h of sub.#hooks[stage]) {
        this.#hooks[stage].push({ prefix: remap(h.prefix), fn: h.fn });
      }
    }
    for (const r of sub.#routes) {
      this.#routes.push({ ...r, path: join(P, r.path) });
    }
    return this;
  }

  /** Кастомный обработчик 404 (иначе 404 отдаёт Rust без пробуждения JS). */
  notFound(handler: Handler): this {
    this.#notFound = handler;
    return this;
  }

  // --- запуск ---

  /** Слушать TCP (`{ port, host }`) либо Unix-сокет (`{ path }`) — §6c B9. */
  async listen({ port, host = '0.0.0.0', path }: ListenArgs = {}): Promise<this> {
    if (path != null) {
      if (typeof path !== 'string') throw new TypeError('listen: path должен быть строкой');
      this.#options.unixPath = path;
      port = 0; // нативный слой игнорирует порт при заданном unixPath
    } else if (typeof port !== 'number') {
      throw new TypeError('listen: нужен числовой port либо path для Unix-сокета');
    }
    installSafetyNet();

    // Схемы: конвертация в JSON Schema (для Rust) + инъекция valibot-preValidation.
    if (this.#routes.some((r) => r.schema != null)) await loadSchemaDeps();
    this.#responseStrip = this.#routes.map((r) => compileResponseStrip(r.schema));
    for (const r of this.#routes) injectValidation(r);

    // Предкомпиляция цепочек для каждого листа маршрута.
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
        // napi передаёт кортеж (MatchedRequest, BodyIo) одним аргументом-массивом.
        ([req, bodyIo]: [NativeRequest, BodyIo]) => this.#dispatch(req, bodyIo),
      );
    } catch (err) {
      // Bind падает синхронно (EADDRINUSE и т.п.) — отдаём и событием, и reject'ом.
      // emit только при наличии слушателя: 'error' без подписчика в EventEmitter
      // роняет процесс, а у нас инвариант «процесс не падает» (§8).
      if (this.#events.listenerCount('error') > 0) this.#events.emit('error', err);
      throw err;
    }

    this.#listening = true;
    if (this.#handleSignals) this.#installSignalHandlers();
    this.#events.emit('listening', path != null ? { path } : { port, host });
    return this;
  }

  /** Подписка на server-события: `listening`, `error`, `close`, `shutdown` (§6d B7). */
  on<E extends ServerEvent>(event: E, fn: ServerEventMap[E]): this {
    this.#events.on(event, fn as (...args: unknown[]) => void);
    return this;
  }
  off<E extends ServerEvent>(event: E, fn: ServerEventMap[E]): this {
    this.#events.off(event, fn as (...args: unknown[]) => void);
    return this;
  }

  /** Graceful shutdown (§10): закрыть listener, дожать in-flight, затем резолвнуться.
   *  Идемпотентен и безопасен для параллельных вызовов — все ждут один и тот же drain. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      this.#events.emit('shutdown');
      // Readiness снимается в Rust в начале drain'а; здесь гасим свой таймер,
      // чтобы он не перевыставил флаг обратно посреди остановки.
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

  /** Тест-харнесс без сокета (§17): запрос идёт по in-memory каналу через тот же
   *  конвейер — роутинг, схемы, CORS, метрики, JS-луковица.
   *
   *  Если сервер ещё не поднят, поднимаем его на эфемерном порту (маршруты и схемы
   *  компилируются именно в `listen()`); сам запрос через сокет не идёт. */
  async inject(req: InjectRequest = {}): Promise<InjectResult> {
    const { method = 'GET', path = '/', headers = {}, body, query } = req;
    if (this.#closed) throw new Error('inject: сервер закрыт (close() уже вызван)');
    if (!this.#listening) await this.listen({ port: 0, host: '127.0.0.1' });

    let url = path;
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams(query).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }

    const pairs: KvPair[] = [];
    for (const [k, v] of Object.entries(headers)) {
      for (const one of Array.isArray(v) ? v : [v]) {
        const value = String(one);
        // Значение заголовка обязано укладываться в байты (ByteString): реальный
        // HTTP-клиент откажется такое отправить, и харнесс обязан вести себя так же.
        // Иначе тест на inject зелёный, а тот же код по сети падает.
        const bad = [...value].findIndex((ch) => ch.codePointAt(0)! > 0xff);
        if (bad >= 0) {
          throw new TypeError(
            `inject: значение заголовка «${k}» содержит символ вне диапазона байта ` +
              `(позиция ${bad}); HTTP такое не передаёт`,
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

    // Заголовки отдаём и объектом (удобно ассертить), и списком пар (set-cookie
    // может повторяться, а объект схлопнул бы дубликаты).
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

  /** Ручной readiness (§11): `false` → `/readyz` отдаёт 503, liveness не трогаем. */
  setReady(ready: boolean): this {
    this.#native.setReady(Boolean(ready));
    return this;
  }

  /** Периодическая проверка готовности (§11): БД, очередь, прогрев кеша.
   *
   *  Колбэк крутится по таймеру на JS-стороне и пушит результат в Rust, а `/readyz`
   *  отвечает мгновенно из атомика. Иначе каждая проба k8s (раз в секунду на под)
   *  будила бы event loop — ровно то, чего пробы в Rust и должны избегать.
   *  Ошибка/таймаут колбэка трактуются как «не готов». */
  setReadinessCheck(
    fn: () => boolean | void | Promise<boolean | void>,
    { interval = 2000, timeout = 1000 }: ReadinessCheckOptions = {},
  ): this {
    if (typeof fn !== 'function') throw new TypeError('setReadinessCheck: нужна функция');
    this.#stopReadinessCheck();

    const tick = async (): Promise<void> => {
      let ok = false;
      try {
        const verdict = await Promise.race([
          Promise.resolve(fn()),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('timeout')), timeout),
          ),
        ]);
        ok = verdict !== false; // undefined/любое не-false = готов
      } catch {
        ok = false; // упал или не уложился — считаем неготовым
      }
      if (this.#readinessTimer) this.setReady(ok);
    };

    this.#readinessTimer = setInterval(() => void tick(), interval);
    // Таймер не должен держать процесс живым сам по себе.
    this.#readinessTimer.unref?.();
    void tick(); // первый прогон сразу, не ждём интервал
    return this;
  }

  #stopReadinessCheck(): void {
    if (!this.#readinessTimer) return;
    clearInterval(this.#readinessTimer);
    this.#readinessTimer = null;
  }

  /** SIGTERM/SIGINT → graceful shutdown → exit 0 (k8s: §10). */
  #installSignalHandlers(): void {
    if (this.#signalCleanup) return;
    const onSignal = (): void => {
      this.close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    const handlers: Array<[NodeJS.Signals, () => void]> = [
      ['SIGTERM', onSignal],
      ['SIGINT', onSignal],
    ];
    for (const [sig, fn] of handlers) process.on(sig, fn);
    this.#signalCleanup = () => {
      for (const [sig, fn] of handlers) process.off(sig, fn);
    };
  }

  #removeSignalHandlers(): void {
    if (!this.#signalCleanup) return;
    this.#signalCleanup();
    this.#signalCleanup = null;
  }

  async #dispatch(nreq: NativeRequest, bodyIo: BodyIo): Promise<NativeResponse> {
    const chain = nreq.leafId < 0 ? this.#notFoundChain : this.#chains[nreq.leafId];
    if (!chain) {
      // Недостижимо: таблица маршрутов и цепочки строятся из одного массива.
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

    try {
      if (this.#requestTimeout) {
        await withTimeout(chain, c, this.#requestTimeout, controller);
      } else {
        await runCore(chain, c);
      }
      // «до-записи» хуки — всегда (short-circuit/normal/error/timeout).
      await runAfterHooks(chain.preSerialization, c);
      await runAfterHooks(chain.onSend, c);
    } catch (err) {
      // Последний рубеж: ошибка в onSend/preSerialization → 500 (или статус HttpError).
      if (!c._finalized) {
        c._body = undefined;
        if (err instanceof HttpError) c.text(err.message || 'Error', err.status);
        else c.text('Internal Server Error', 500);
      }
    }

    const response = buildNativeResponse(c);

    // onResponse — наблюдение, всегда; ошибки глушим (не влияют на ответ).
    try {
      await runAfterHooks(chain.onResponse, c);
    } catch {
      // onResponse не должен ломать ответ
    }
    return response;
  }
}

const DEFAULT_CORS_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'];

/** Нормализовать config.cors к нативным CorsOptions (§6a).
 *  Option<Vec>-поля napi не принимают null → опускаем ключ, когда не задан. */
function normalizeCors(cors: CorsConfig): NativeCorsOptions {
  const origin = cors.origin ?? '*';
  const out: NativeCorsOptions = {
    origins: Array.isArray(origin) ? origin : [origin],
    methods: cors.methods ?? DEFAULT_CORS_METHODS,
    credentials: Boolean(cors.credentials),
  };
  // napi Option<T> не принимает null → задаём ключ только когда значение есть.
  if (cors.allowedHeaders) out.allowedHeaders = cors.allowedHeaders; // иначе отражаем запрошенные
  if (cors.exposedHeaders) out.exposedHeaders = cors.exposedHeaders;
  if (cors.maxAge != null) out.maxAge = Math.floor(cors.maxAge);
  return out;
}

/** Резолв TLS: путь → чтение файла, Buffer → строка, PEM-строка как есть (§12). */
function resolveTls(tls: TlsConfig): { cert: string; key: string } {
  return { cert: resolvePem(tls.cert), key: resolvePem(tls.key) };
}
function resolvePem(v: string | Buffer): string {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'string') {
    return v.includes('-----BEGIN') ? v : fs.readFileSync(v, 'utf8');
  }
  throw new TypeError('tls cert/key: строка (PEM или путь) либо Buffer');
}

/** Нормализовать config.http2 → нативные Http2Options (initialWindowSize принимает '1mb'). */
function normalizeHttp2(h: Http2Config): NativeHttp2Options {
  const out: NativeHttp2Options = {};
  if (h.maxConcurrentStreams != null) out.maxConcurrentStreams = h.maxConcurrentStreams;
  if (h.initialWindowSize != null) out.initialWindowSize = parseBytes(h.initialWindowSize);
  if (h.maxResetStreamsPerSec != null) out.maxResetStreamsPerSec = h.maxResetStreamsPerSec;
  return out;
}

/** Нормализовать опцию multipart (`true` | `{...}`) к нативным MultipartOptions (§9a). */
function normalizeMultipart(mp: boolean | MultipartConfig): NativeMultipartOptions {
  const o: MultipartConfig = mp === true ? {} : mp === false ? {} : mp;
  const out: NativeMultipartOptions = {
    maxFileSize: parseBytes(o.maxFileSize ?? '50mb'),
    maxFieldSize: parseBytes(o.maxFieldSize ?? '1mb'),
    maxFiles: o.maxFiles ?? 10,
    maxFields: o.maxFields ?? 100,
  };
  // Option<Vec> napi не принимает null → ключ только когда задан.
  if (o.allowedMimeTypes) out.allowedMimeTypes = o.allowedMimeTypes;
  if (o.allowedExtensions) out.allowedExtensions = o.allowedExtensions;
  return out;
}

/** Собрать map статус→Set(имён свойств) для стрипа ответа по response-схеме. */
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

/** Внедрить синтетический preValidation-хук для valibot transform/refine (§6b). */
function injectValidation(route: RouteEntry): void {
  const schema = route.schema;
  if (!schema) return;

  const valibotSchemas: Partial<Record<(typeof VALIDATED_LOCATIONS)[number], ValibotSchema>> = {};
  for (const loc of VALIDATED_LOCATIONS) {
    const s: SchemaSource | undefined = schema[loc];
    if (isValibot(s)) valibotSchemas[loc] = s;
  }
  if (Object.keys(valibotSchemas).length === 0) return; // сырой JSON Schema — transform не нужен

  const hook: Hook = async (c: Context) => {
    for (const loc of VALIDATION_ORDER) {
      const vs = valibotSchemas[loc];
      if (!vs) continue;
      // Сырое значение: коэрцированное из Rust; для сжатого тела читаем в JS.
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
      c.req._valid[loc] = res.output; // transform применён
    }
  };

  route.hooks = {
    ...route.hooks,
    preValidation: [hook, ...(route.hooks.preValidation ?? [])],
  };
}

/** Нормализовать route-опции `{onRequest:[...]|fn, preHandler, ...}` к `{stage:[fn]}`. */
function normalizeRouteHooks(opts: RouteOptions): Partial<Record<StageName, Hook[]>> {
  const hooks: Partial<Record<StageName, Hook[]>> = {};
  for (const stage of ALL_STAGES) {
    const v = opts[stage];
    if (v == null) continue;
    hooks[stage] = Array.isArray(v) ? v : [v];
  }
  return hooks;
}
