'use strict';

// Контекст `c` (§7) и финализация ответа. Заголовки — lowercase; `Set-Cookie`
// отдаётся отдельными строками; возврат значения из хендлера — сахар над c.json.
// Тело запроса/ответа — стриминг через BodyIo с backpressure (§9).

const zlib = require('node:zlib');

/** Ошибка с HTTP-статусом (перехватывается диспетчером → отдаётся клиенту). */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

const toBuffer = (chunk) =>
  Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);

/** Маркеры обрыва тела, приходящие из нативного read() (см. src/stream.rs). */
const isLimitError = (e) => e != null && /BODY_LIMIT_EXCEEDED/.test(String(e.message));
const isReadTimeout = (e) => e != null && /BODY_READ_TIMEOUT/.test(String(e.message));

/** Прочитать чанк, маппя нативные маркеры в HttpError (413 / 408). */
async function readChunk(bodyIo) {
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
async function collectRaw(bodyIo, limit) {
  const chunks = [];
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
function decompress(buf, encoding, limit) {
  const enc = (encoding || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return buf;
  const opts = limit != null ? { maxOutputLength: limit } : {};
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf, opts);
    if (enc === 'deflate') return zlib.inflateSync(buf, opts);
    if (enc === 'br') return zlib.brotliDecompressSync(buf, opts);
    return buf; // неизвестная кодировка — не трогаем
  } catch (e) {
    if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String(e.message)))) {
      throw new HttpError(413, 'Payload Too Large');
    }
    throw new HttpError(400, 'Invalid compressed body');
  }
}

/** Web ReadableStream над телом запроса (pull → bodyIo.read). Превышение лимита
 *  (в Rust) → ошибка стрима с HttpError(413), которую поймает for-await хендлера. */
function makeReqStream(bodyIo) {
  return new ReadableStream({
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
function startResponsePump(bodyIo, source) {
  (async () => {
    try {
      if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
        await bodyIo.write(toBuffer(source));
      } else if (typeof source?.getReader === 'function') {
        const reader = source.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value != null) await bodyIo.write(toBuffer(value));
        }
      } else if (source?.[Symbol.asyncIterator]) {
        for await (const chunk of source) if (chunk != null) await bodyIo.write(toBuffer(chunk));
      }
    } catch {
      // producer/соединение оборвались — просто закрываем тело.
    } finally {
      bodyIo.endWrite();
    }
  })();
}

const isStreamSource = (v) =>
  Buffer.isBuffer(v) || v instanceof Uint8Array || typeof v?.getReader === 'function' || v?.[Symbol.asyncIterator] != null;

// --- multipart (§9a): парсинг в Rust, здесь — итератор частей ---

/** Отклонение из Rust ("MULTIPART_REJECT:<status>:<msg>") → HttpError. */
function mpMapError(e) {
  const m = /^MULTIPART_REJECT:(\d+):(.*)$/s.exec(e && e.message);
  return m ? new HttpError(Number(m[1]), m[2]) : e;
}

async function mpNextPart(bodyIo) {
  try {
    return await bodyIo.nextPart();
  } catch (e) {
    throw mpMapError(e);
  }
}
async function mpReadPart(bodyIo) {
  try {
    return await bodyIo.readPart();
  } catch (e) {
    throw mpMapError(e);
  }
}

/** Собрать объект-часть с потоком/буферизацией. */
function makePart(bodyIo, meta) {
  const collect = async () => {
    const chunks = [];
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
    get stream() {
      return new ReadableStream({
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
    async arrayBuffer() {
      const b = await collect();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    async text() {
      return (await collect()).toString('utf8');
    },
  };
}

/** Async-итератор частей multipart (потоково, §9a). */
async function* partsIterator(bodyIo) {
  let meta;
  while ((meta = await mpNextPart(bodyIo)) != null) {
    yield makePart(bodyIo, meta);
  }
}

/** Заголовки ответа: lowercase, set/append, несколько значений (set-cookie). */
class ResHeaders {
  #map = new Map(); // lk -> string[]

  set(name, value) {
    this.#map.set(name.toLowerCase(), [String(value)]);
    return this;
  }
  append(name, value) {
    const lk = name.toLowerCase();
    const arr = this.#map.get(lk) ?? [];
    arr.push(String(value));
    this.#map.set(lk, arr);
    return this;
  }
  get(name) {
    const arr = this.#map.get(name.toLowerCase());
    return arr ? arr[0] : undefined;
  }
  has(name) {
    return this.#map.has(name.toLowerCase());
  }
  delete(name) {
    this.#map.delete(name.toLowerCase());
    return this;
  }
  /** Плоский список пар (с повторами) для нативного слоя. */
  toPairs() {
    const out = [];
    for (const [key, arr] of this.#map) for (const value of arr) out.push({ key, value });
    return out;
  }
}

/** Разобрать заголовки запроса (Vec<KvPair>, уже lowercase) в map с join дублей. */
function buildReqHeaders(pairs) {
  const map = new Map();
  for (const { key, value } of pairs) {
    map.set(key, map.has(key) ? `${map.get(key)}, ${value}` : value);
  }
  return map;
}

/** Разобрать заголовок Cookie в объект { name: value }. */
function parseCookies(cookieHeader) {
  const out = Object.create(null);
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
function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge != null) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.domain) s += `; Domain=${opts.domain}`;
  s += `; Path=${opts.path ?? '/'}`;
  if (opts.expires instanceof Date) s += `; Expires=${opts.expires.toUTCString()}`;
  if (opts.httpOnly) s += '; HttpOnly';
  if (opts.secure) s += '; Secure';
  if (opts.sameSite) {
    const v = String(opts.sameSite);
    s += `; SameSite=${v[0].toUpperCase()}${v.slice(1).toLowerCase()}`;
  }
  return s;
}

/** Контекстный логгер: структурный JSON в stdout с requestId (§6d B3). */
function makeLogger(requestId) {
  const emit = (level, msg, extra) =>
    process.stdout.write(
      JSON.stringify({ level, time: new Date().toISOString(), requestId, msg, ...extra }) + '\n',
    );
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
function buildContext(
  nreq,
  bodyIo,
  { baseUrl = '', requestIdHeader = 'x-request-id', bodyLimit, responseStrip = null } = {},
) {
  const reqHeaders = buildReqHeaders(nreq.headers);

  // Провалидированные в Rust значения (JSON-строки) → объекты для c.req.valid().
  const rustValid = {
    body: nreq.validBody != null ? JSON.parse(nreq.validBody) : undefined,
    query: nreq.validQuery != null ? JSON.parse(nreq.validQuery) : undefined,
    params: nreq.validParams != null ? JSON.parse(nreq.validParams) : undefined,
  };

  const rawPath = nreq.path;
  const path = baseUrl && rawPath.startsWith(baseUrl) ? rawPath.slice(baseUrl.length) || '/' : rawPath;
  const url = nreq.queryString ? `${rawPath}?${nreq.queryString}` : rawPath;

  const queryLast = Object.create(null);
  const queryMulti = Object.create(null);
  for (const { key, value } of nreq.query) {
    queryLast[key] = value;
    (queryMulti[key] ??= []).push(value);
  }

  let cookies;

  // --- тело запроса (стриминг + буферизация с лимитом/декомпрессией) ---
  let bodyUsed = false;
  const useBody = () => {
    if (bodyUsed) throw new Error('тело запроса уже прочитано');
    bodyUsed = true;
  };
  const readBuffered = async () => {
    const raw = await collectRaw(bodyIo, bodyLimit);
    return decompress(raw, reqHeaders.get('content-encoding'), bodyLimit);
  };
  const arrayBuffer = async () => {
    useBody();
    const buf = await readBuffered();
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  };
  const text = async () => Buffer.from(await arrayBuffer()).toString('utf8');
  const parseBody = async () => Object.fromEntries(new URLSearchParams(await text()));

  const res = { status: undefined, headers: new ResHeaders(), sent: false };
  // request-id пробрасываем в ответ по умолчанию (§6d B2).
  res.headers.set(requestIdHeader, nreq.id);

  const c = {
    req: {
      method: nreq.method,
      path,
      rawPath,
      url,
      params: nreq.params,
      query: queryLast,
      queries: (k) => queryMulti[k] ?? [],
      header: (name) => reqHeaders.get(name.toLowerCase()),
      get headers() {
        return Object.fromEntries(reqHeaders);
      },
      ip: nreq.ip,
      ips: nreq.ips,
      country: nreq.country ?? undefined,
      id: nreq.id,
      signal: undefined, // AbortSignal (таймаут/дисконнект) — ставит диспетчер
      cookie: (name) => (cookies ??= parseCookies(reqHeaders.get('cookie')))[name],
      // тело
      get stream() {
        useBody();
        return makeReqStream(bodyIo);
      },
      arrayBuffer,
      text,
      json: async () => JSON.parse(await text()),
      parseBody,
      // multipart: потоковый итератор частей (§9a)
      parts() {
        useBody();
        return partsIterator(bodyIo);
      },
      formData: async () => {
        const ct = reqHeaders.get('content-type') || '';
        const fd = new FormData();
        if (ct.startsWith('multipart/form-data')) {
          useBody();
          for await (const part of partsIterator(bodyIo)) {
            if (part.filename != null) {
              const buf = Buffer.from(await part.arrayBuffer());
              const opts = part.contentType ? { type: part.contentType } : {};
              fd.append(part.name, new Blob([buf], opts), part.filename);
            } else {
              fd.append(part.name, await part.text());
            }
          }
        } else {
          for (const [k, v] of new URLSearchParams(await text())) fd.append(k, v);
        }
        return fd;
      },
      // валидация (§6b): valibot-transform (_valid) поверх Rust-коэрции (_rustValid)
      _rustValid: rustValid,
      _valid: Object.create(null),
      valid(loc) {
        return this._valid[loc] !== undefined ? this._valid[loc] : this._rustValid[loc];
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
    _store: new Map(),
    set(k, v) {
      this._store.set(k, v);
      return this;
    },
    get(k) {
      return this._store.get(k);
    },

    // мутаторы ответа (после фиксации ответа — no-op: защита от гонки таймаута)
    status(n) {
      if (!this._settled) res.status = n;
      return this;
    },
    header(k, v) {
      if (!this._settled) res.headers.set(k, v);
      return this;
    },
    cookie(name, value, opts) {
      if (!this._settled) res.headers.append('set-cookie', serializeCookie(name, value, opts));
      return this;
    },

    // финализирующие хелперы
    json(v, status) {
      if (this._settled) return this;
      res.headers.set('content-type', CT_JSON);
      this._body = JSON.stringify(v);
      this._stream = undefined;
      if (status != null) res.status = status;
      this._finalized = true;
      return this;
    },
    text(v, status) {
      if (this._settled) return this;
      res.headers.set('content-type', CT_TEXT);
      this._body = String(v);
      this._stream = undefined;
      if (status != null) res.status = status;
      this._finalized = true;
      return this;
    },
    body(data, status) {
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
    redirect(location, status = 302) {
      return this.status(status).header('location', location).body('');
    },
    notFound() {
      return this.text('Not Found', 404);
    },
  };

  return c;
}

/** Применить возврат-значение хендлера как сахар (string→text, stream→body, else json). */
function applyReturnValue(c, returnValue) {
  if (!c._finalized && returnValue != null && returnValue !== c) {
    if (typeof returnValue === 'string') c.text(returnValue);
    else if (isStreamSource(returnValue)) c.body(returnValue);
    else c.json(returnValue);
  }
}

/** Свести контекст к нативному JsResponse (запускает pump для стрим-тела). */
function buildNativeResponse(c) {
  c._settled = true;
  c.res.sent = true;
  const status = c.res.status ?? 200;
  if (c._stream != null) {
    startResponsePump(c._bodyIo, c._stream);
    return { status, headers: c.res.headers.toPairs(), streamed: true };
  }
  // Стрип ответа по response-схеме: не утечёт то, чего нет в схеме (§6b).
  const body = stripResponse(c, status);
  return { status, headers: c.res.headers.toPairs(), body };
}

/** Отсечь поля верхнего уровня, которых нет в response-схеме для статуса. */
function stripResponse(c, status) {
  const strip = c._responseStrip;
  if (!strip || c._body == null) return c._body;
  const props = strip[status] ?? strip[String(status)];
  if (!props) return c._body;
  const ct = c.res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return c._body;
  try {
    const parsed = JSON.parse(c._body);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return c._body;
    const out = {};
    for (const k of Object.keys(parsed)) if (props.has(k)) out[k] = parsed[k];
    return JSON.stringify(out);
  } catch {
    return c._body;
  }
}

module.exports = {
  buildContext,
  applyReturnValue,
  buildNativeResponse,
  HttpError,
  ResHeaders,
  serializeCookie,
  parseCookies,
};
