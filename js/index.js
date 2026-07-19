'use strict';

// Публичная JS-обёртка над нативным `RustServer`. Регистрация маршрутов,
// middleware (луковица) и хуков жизненного цикла; роутинг/матчинг/404/405 — в Rust.
// Цепочки предкомпилируются на listen() (см. pipeline.js), контекст — context.js.

const { EventEmitter } = require('node:events');
const { RustServer } = require('../index.js');
const { buildContext, buildNativeResponse, HttpError } = require('./context.js');
const { parseBytes, parseDuration } = require('./units.js');
const {
  buildChain,
  runCore,
  withTimeout,
  runAfterHooks,
  ALL_STAGES,
} = require('./pipeline.js');
const {
  isValibot,
  toJsonSchemaString,
  topProps,
  valibotSafeParse,
  valibotIssues,
} = require('./schema.js');

// Страховочный process-level хендлер (§8): в норме не срабатывает — срабатывание
// означает баг обёртки (не пойманный reject). Логируем, но процесс НЕ роняем.
let safetyNetInstalled = false;
function installSafetyNet() {
  if (safetyNetInstalled) return;
  safetyNetInstalled = true;
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        msg: 'unhandledRejection (баг обёртки @oxide/http — процесс не падает)',
        reason: reason instanceof Error ? reason.stack : String(reason),
      }) + '\n',
    );
  });
}

/** Именованные хуки жизненного цикла (методы app.<hook>(fn) + addHook). */
const HOOK_NAMES = [
  'onRequest',
  'preParsing',
  'preValidation',
  'preHandler',
  'preSerialization',
  'onSend',
  'onResponse',
  'onTimeout',
  'onAbort',
  'onConnect',
  'onClose',
];

/** Нормализация префикса: '' | '/' → ''; ведущий слэш обяз.; хвостовой (и /*) убираем. */
function normalizeBase(b) {
  if (!b || b === '/') return '';
  let s = b.startsWith('/') ? b : '/' + b;
  if (s.endsWith('/*')) s = s.slice(0, -2);
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s || '';
}

/** Склейка префикса и пути маршрута (path === '/' не даёт двойного слэша). */
function join(base, path) {
  const p = path.startsWith('/') ? path : '/' + path;
  if (p === '/') return base === '' ? '/' : base;
  return base + p;
}

/** Пустой набор хуков по стадиям. */
function emptyHooks() {
  const h = {};
  for (const stage of ALL_STAGES) h[stage] = [];
  return h;
}

class Server {
  #native;
  #routes = []; // [{ method, path, middleware:[fn], hooks:{stage:[fn]}, handler }]
  #middleware = []; // [{ prefix, fn }] — луковица (глобальные + префиксные)
  #hooks = emptyHooks(); // { stage: [{ prefix, fn }] } — глобальные хуки
  #baseUrl = '';
  #notFound = null;
  #chains = []; // предкомпилированные цепочки по leafId (после listen)
  #notFoundChain = null;
  #responseStrip = []; // по leafId: map статус→Set(props) для стрипа ответа
  #options;
  #requestIdHeader;
  #bodyLimit;
  #requestTimeout;
  #events = new EventEmitter();
  #listening = false;
  #closing = null; // Promise текущего close() — делает close() идемпотентным
  #signalCleanup = null;
  #handleSignals;

  constructor(config = {}) {
    this.#baseUrl = normalizeBase(config.baseUrl);
    this.#requestIdHeader = (config.requestId?.header ?? 'x-request-id').toLowerCase();
    this.#bodyLimit = parseBytes(config.bodyLimit ?? '10mb');
    this.#requestTimeout = config.requestTimeout != null ? parseDuration(config.requestTimeout) : null;
    this.#options = {
      customIpHeaders: config.customIpHeaders ?? [],
      customCountryHeaders: config.customCountryHeaders ?? [],
      requestIdHeader: this.#requestIdHeader,
      bodyLimit: this.#bodyLimit ?? null,
    };
    // Опциональные объекты/Option-поля задаём только когда есть: napi не принимает null.
    if (config.cors) this.#options.cors = normalizeCors(config.cors);
    if (config.tls) this.#options.tls = resolveTls(config.tls);
    if (config.h2c) this.#options.h2c = true;
    if (config.headerReadTimeout != null) {
      this.#options.headerReadTimeout = parseDuration(config.headerReadTimeout);
    }
    if (config.bodyReadTimeout != null) {
      this.#options.bodyReadTimeout = parseDuration(config.bodyReadTimeout);
    }
    if (config.idleTimeout != null) {
      this.#options.idleTimeout = parseDuration(config.idleTimeout);
    }
    if (config.handshakeTimeout != null) {
      this.#options.handshakeTimeout = parseDuration(config.handshakeTimeout);
    }
    if (config.maxHeaders != null) this.#options.maxHeaders = config.maxHeaders;
    if (config.maxHeaderSize != null) this.#options.maxHeaderSize = parseBytes(config.maxHeaderSize);
    if (config.shutdownTimeout != null) {
      this.#options.shutdownTimeout = parseDuration(config.shutdownTimeout);
    }
    // Socket-опции (§6c B9) и PROXY protocol (A4).
    if (config.backlog != null) this.#options.backlog = config.backlog;
    if (config.reusePort != null) this.#options.reusePort = !!config.reusePort;
    if (config.noDelay != null) this.#options.noDelay = !!config.noDelay;
    if (config.maxConnections != null) this.#options.maxConnections = config.maxConnections;
    if (config.proxyProtocol != null) this.#options.proxyProtocol = !!config.proxyProtocol;
    // workerThreads: число | 'auto' (по cgroup-квоте). 'auto' = не задавать явно.
    if (typeof config.workerThreads === 'number') {
      this.#options.workerThreads = config.workerThreads;
    } else if (config.workerThreads != null && config.workerThreads !== 'auto') {
      throw new TypeError("workerThreads: число либо 'auto'");
    }
    // SIGTERM/SIGINT → graceful shutdown (§10). Выключается { handleSignals: false }
    // — например когда процессом уже управляет внешний супервизор.
    this.#handleSignals = config.handleSignals !== false;
    if (config.http2) this.#options.http2 = normalizeHttp2(config.http2);
    this.#native = new RustServer();

    // Именованные методы-хуки: app.onRequest(fn), app.preHandler(fn), ...
    for (const name of HOOK_NAMES) {
      this[name] = (fn) => this.addHook(name, fn);
    }
  }

  // --- маршруты ---

  #add(method, path, args) {
    // args: [options?, ...middleware, handler]
    const list = [...args];
    let hooks = null;
    let schema = null;
    let multipart = null;
    if (list.length > 1 && typeof list[0] === 'object' && list[0] !== null) {
      const opts = list.shift();
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
      middleware: list, // маршрутные middleware (перед хендлером)
      hooks: hooks || {},
      schema, // { body?, query?, params?, response? } — valibot | JSON Schema
      multipart, // нормализованные опции multipart | null
      handler,
    });
    return this;
  }

  get(path, ...a) { return this.#add('GET', path, a); }
  post(path, ...a) { return this.#add('POST', path, a); }
  put(path, ...a) { return this.#add('PUT', path, a); }
  patch(path, ...a) { return this.#add('PATCH', path, a); }
  delete(path, ...a) { return this.#add('DELETE', path, a); }
  head(path, ...a) { return this.#add('HEAD', path, a); }
  options(path, ...a) { return this.#add('OPTIONS', path, a); }
  all(path, ...a) { return this.#add('ALL', path, a); }

  // --- middleware (луковица) ---

  /** app.use(fn) — глобальный; app.use(prefix, ...fns) — по префиксу. */
  use(...args) {
    let prefix = this.#baseUrl;
    if (typeof args[0] === 'string') {
      prefix = join(this.#baseUrl, normalizeBase(args.shift()));
    }
    for (const fn of args) {
      if (typeof fn !== 'function') throw new TypeError('use: middleware должен быть функцией');
      this.#middleware.push({ prefix, fn });
    }
    return this;
  }

  // --- хуки ---

  /** Обобщённая регистрация хука (именованные методы навешаны в конструкторе). */
  addHook(name, fn) {
    if (name === 'onError') return this.onError(fn);
    if (!this.#hooks[name]) throw new TypeError(`неизвестный хук: ${name}`);
    if (typeof fn !== 'function') throw new TypeError(`${name}: обработчик должен быть функцией`);
    this.#hooks[name].push({ prefix: this.#baseUrl, fn });
    return this;
  }

  /** Единый обработчик ошибок onError(err, c). Можно навесить несколько. */
  onError(fn) {
    if (typeof fn !== 'function') throw new TypeError('onError: обработчик должен быть функцией');
    this.#hooks.onError.push({ prefix: this.#baseUrl, fn });
    return this;
  }

  // --- группы ---

  /** Смонтировать суб-приложение под префиксом (инкапсуляция через префикс-матчинг). */
  route(prefix, sub) {
    if (!(sub instanceof Server)) {
      throw new TypeError('route(prefix, sub): sub должен быть экземпляром Server');
    }
    const P = join(this.#baseUrl, normalizeBase(prefix));
    const remap = (pfx) => (pfx === '' ? P : join(P, pfx));

    for (const m of sub.#middleware) this.#middleware.push({ prefix: remap(m.prefix), fn: m.fn });
    for (const stage of ALL_STAGES) {
      for (const h of sub.#hooks[stage]) this.#hooks[stage].push({ prefix: remap(h.prefix), fn: h.fn });
    }
    for (const r of sub.#routes) {
      this.#routes.push({ ...r, path: join(P, r.path) });
    }
    return this;
  }

  /** Кастомный обработчик 404 (иначе 404 отдаёт Rust без пробуждения JS). */
  notFound(handler) {
    this.#notFound = handler;
    return this;
  }

  // --- запуск ---

  /** Слушать TCP (`{ port, host }`) либо Unix-сокет (`{ path }`) — §6c B9. */
  async listen({ port, host = '0.0.0.0', path } = {}) {
    if (path != null) {
      if (typeof path !== 'string') throw new TypeError('listen: path должен быть строкой');
      this.#options.unixPath = path;
      port = 0; // нативный слой игнорирует порт при заданном unixPath
    } else if (typeof port !== 'number') {
      throw new TypeError('listen: нужен числовой port либо path для Unix-сокета');
    }
    installSafetyNet();

    // Схемы: конвертация в JSON Schema (для Rust) + инъекция valibot-preValidation.
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

    const table = this.#routes.map((r, i) => {
      const entry = { method: r.method, path: r.path, leafId: i };
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
        ([req, bodyIo]) => this.#dispatch(req, bodyIo),
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
  on(event, fn) {
    this.#events.on(event, fn);
    return this;
  }
  off(event, fn) {
    this.#events.off(event, fn);
    return this;
  }

  /** Graceful shutdown (§10): закрыть listener, дожать in-flight, затем резолвнуться.
   *  Идемпотентен и безопасен для параллельных вызовов — все ждут один и тот же drain. */
  close() {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      this.#events.emit('shutdown');
      await this.#native.close();
      this.#listening = false;
      this.#removeSignalHandlers();
      this.#events.emit('close');
    })();
    return this.#closing;
  }

  get listening() {
    return this.#listening;
  }

  /** SIGTERM/SIGINT → graceful shutdown → exit 0 (k8s: §10). */
  #installSignalHandlers() {
    if (this.#signalCleanup) return;
    const onSignal = (sig) => {
      this.close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
      void sig;
    };
    const handlers = [
      ['SIGTERM', () => onSignal('SIGTERM')],
      ['SIGINT', () => onSignal('SIGINT')],
    ];
    for (const [sig, fn] of handlers) process.on(sig, fn);
    this.#signalCleanup = () => {
      for (const [sig, fn] of handlers) process.off(sig, fn);
    };
  }

  #removeSignalHandlers() {
    if (!this.#signalCleanup) return;
    this.#signalCleanup();
    this.#signalCleanup = null;
  }

  async #dispatch(nreq, bodyIo) {
    const chain = nreq.leafId < 0 ? this.#notFoundChain : this.#chains[nreq.leafId];
    const c = buildContext(nreq, bodyIo, {
      baseUrl: this.#baseUrl,
      requestIdHeader: this.#requestIdHeader,
      bodyLimit: this.#bodyLimit,
      responseStrip: nreq.leafId < 0 ? null : this.#responseStrip[nreq.leafId],
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
function normalizeCors(cors) {
  const origin = cors.origin ?? '*';
  const out = {
    origins: Array.isArray(origin) ? origin : [origin],
    methods: cors.methods ?? DEFAULT_CORS_METHODS,
    credentials: !!cors.credentials,
  };
  // napi Option<T> не принимает null → задаём ключ только когда значение есть.
  if (cors.allowedHeaders) out.allowedHeaders = cors.allowedHeaders; // иначе отражаем запрошенные
  if (cors.exposedHeaders) out.exposedHeaders = cors.exposedHeaders;
  if (cors.maxAge != null) out.maxAge = Math.floor(cors.maxAge);
  return out;
}

/** Резолв TLS: путь → чтение файла, Buffer → строка, PEM-строка как есть (§12). */
function resolveTls(tls) {
  return { cert: resolvePem(tls.cert), key: resolvePem(tls.key) };
}
function resolvePem(v) {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'string') {
    return v.includes('-----BEGIN') ? v : require('node:fs').readFileSync(v, 'utf8');
  }
  throw new TypeError('tls cert/key: строка (PEM или путь) либо Buffer');
}

/** Нормализовать config.http2 → нативные Http2Options (initialWindowSize принимает '1mb'). */
function normalizeHttp2(h) {
  const out = {};
  if (h.maxConcurrentStreams != null) out.maxConcurrentStreams = h.maxConcurrentStreams;
  if (h.initialWindowSize != null) out.initialWindowSize = parseBytes(h.initialWindowSize);
  if (h.maxResetStreamsPerSec != null) out.maxResetStreamsPerSec = h.maxResetStreamsPerSec;
  return out;
}

/** Нормализовать опцию multipart (true | {...}) к нативным MultipartOptions (§9a). */
function normalizeMultipart(mp) {
  const o = mp === true ? {} : mp;
  const out = {
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
function compileResponseStrip(schema) {
  if (!schema || !schema.response) return null;
  const map = {};
  for (const [status, s] of Object.entries(schema.response)) {
    const props = topProps(s);
    if (props) map[status] = props;
  }
  return Object.keys(map).length ? map : null;
}

/** Внедрить синтетический preValidation-хук для valibot transform/refine (§6b). */
function injectValidation(route) {
  if (!route.schema) return;
  const valibotSchemas = {};
  for (const loc of ['body', 'query', 'params']) {
    if (isValibot(route.schema[loc])) valibotSchemas[loc] = route.schema[loc];
  }
  if (Object.keys(valibotSchemas).length === 0) return; // сырой JSON Schema — transform не нужен

  const hook = async (c) => {
    for (const loc of ['params', 'query', 'body']) {
      const vs = valibotSchemas[loc];
      if (!vs) continue;
      // Сырое значение: коэрцированное из Rust; для сжатого тела читаем в JS.
      const raw =
        loc === 'body' && c.req._rustValid.body === undefined
          ? await c.req.json()
          : c.req._rustValid[loc];
      const res = valibotSafeParse(vs, raw);
      if (!res.success) {
        c.json({ error: 'validation', issues: valibotIssues(res.issues, loc) }, 400);
        return; // short-circuit
      }
      c.req._valid[loc] = res.output; // transform применён
    }
  };
  route.hooks = { ...route.hooks, preValidation: [hook, ...(route.hooks.preValidation || [])] };
}

/** Нормализовать route-опции {onRequest:[...]|fn, preHandler, ...} к {stage:[fn]}. */
function normalizeRouteHooks(opts) {
  const hooks = {};
  for (const stage of ALL_STAGES) {
    const v = opts[stage];
    if (v == null) continue;
    hooks[stage] = Array.isArray(v) ? v : [v];
  }
  return hooks;
}

module.exports = { Server, HttpError };
