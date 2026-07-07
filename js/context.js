'use strict';

// Контекст `c` (§7) и финализация ответа. Заголовки — lowercase; `Set-Cookie`
// отдаётся отдельными строками; возврат значения из хендлера — сахар над c.json.

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
function buildContext(nreq, { baseUrl = '', requestIdHeader = 'x-request-id' } = {}) {
  const reqHeaders = buildReqHeaders(nreq.headers);

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

  const res = { status: undefined, headers: new ResHeaders() };
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
      cookie: (name) => (cookies ??= parseCookies(reqHeaders.get('cookie')))[name],
    },
    res,
    _body: undefined,
    _finalized: false,
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

    // мутаторы ответа
    status(n) {
      res.status = n;
      return this;
    },
    header(k, v) {
      res.headers.set(k, v);
      return this;
    },
    cookie(name, value, opts) {
      res.headers.append('set-cookie', serializeCookie(name, value, opts));
      return this;
    },

    // финализирующие хелперы
    json(v, status) {
      res.headers.set('content-type', CT_JSON);
      this._body = JSON.stringify(v);
      if (status != null) res.status = status;
      this._finalized = true;
      return this;
    },
    text(v, status) {
      res.headers.set('content-type', CT_TEXT);
      this._body = String(v);
      if (status != null) res.status = status;
      this._finalized = true;
      return this;
    },
    body(data, status) {
      this._body = data == null ? undefined : String(data);
      if (status != null) res.status = status;
      this._finalized = true;
      return this;
    },
  };

  return c;
}

/** Свести контекст + возврат хендлера к нативному JsResponse. */
function finalizeResponse(c, returnValue) {
  // Возврат-значение как сахар (если хелпер не вызван и вернули не сам c).
  if (!c._finalized && returnValue != null && returnValue !== c) {
    if (typeof returnValue === 'string') c.text(returnValue);
    else c.json(returnValue);
  }

  const status = c.res.status ?? 200;
  return { status, headers: c.res.headers.toPairs(), body: c._body };
}

module.exports = { buildContext, finalizeResponse, ResHeaders, serializeCookie, parseCookies };
