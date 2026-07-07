'use strict';

// Движок жизненного цикла запроса (§6, §6a): Koa-луковица middleware +
// Fastify-хуки. Цепочки предкомпилируются на listen() для каждого листа маршрута.
//
// Порядок: onRequest → preParsing → preValidation → preHandler →
//          [ЛУКОВИЦА middleware → ХЕНДЛЕР] → preSerialization → onSend → (write) → onResponse.
// Short-circuit: любой «до»-хук сформировал ответ → дальше не идём, но «после»-хуки идут всегда.
// Ошибка в любом слое → onError. onTimeout/onAbort — отдельные ветки.

const { HttpError, applyReturnValue } = require('./context.js');

const BEFORE_STAGES = ['onRequest', 'preParsing', 'preValidation', 'preHandler'];
const AFTER_STAGES = ['preSerialization', 'onSend'];
const OTHER_STAGES = ['onResponse', 'onError', 'onTimeout', 'onAbort', 'onConnect', 'onClose'];
const ALL_STAGES = [...BEFORE_STAGES, ...AFTER_STAGES, ...OTHER_STAGES];

/** Совпадает ли префикс middleware/хука с путём маршрута. */
function prefixMatches(prefix, path) {
  return prefix === '' || path === prefix || path.startsWith(prefix + '/');
}

/** Предкомпиляция цепочки для одного маршрута: глобальные (по префиксу) + маршрутные. */
function buildChain(route, globalMiddleware, globalHooks) {
  const chain = { handler: route.handler };
  chain.middleware = [
    ...globalMiddleware.filter((m) => prefixMatches(m.prefix, route.path)).map((m) => m.fn),
    ...(route.middleware || []),
  ];
  for (const stage of ALL_STAGES) {
    const globals = (globalHooks[stage] || [])
      .filter((h) => prefixMatches(h.prefix, route.path))
      .map((h) => h.fn);
    const routeLevel = (route.hooks && route.hooks[stage]) || [];
    chain[stage] = [...globals, ...routeLevel];
  }
  return chain;
}

/** Прогнать «до»-хуки стадии; short-circuit прерывает на первом сформировавшем ответ. */
async function runBeforeHooks(hooks, c) {
  for (const hook of hooks) {
    await hook(c);
    if (c._finalized) break;
  }
}

/** Прогнать «после»-хуки: идут все (могут дорабатывать ответ), ошибка всплывает. */
async function runAfterHooks(hooks, c) {
  for (const hook of hooks) await hook(c);
}

/** Луковица: middleware `(c, next)` вокруг хендлера. */
async function runOnion(middleware, handler, c) {
  let index = -1;
  const dispatch = async (i) => {
    if (i <= index) throw new Error('next() вызван несколько раз');
    index = i;
    if (i < middleware.length) {
      await middleware[i](c, () => dispatch(i + 1));
    } else {
      const result = await handler(c);
      applyReturnValue(c, result);
    }
  };
  await dispatch(0);
}

/** Сформировать ответ по ошибке: onError-хуки → c.res, иначе дефолт по статусу. */
function defaultError(c, err) {
  if (err instanceof HttpError) c.text(err.message || 'Error', err.status);
  else c.text('Internal Server Error', 500);
}

async function handleError(chain, c, err) {
  c.error = err;
  if (chain.onError.length === 0) {
    defaultError(c, err);
    return;
  }
  try {
    for (const hook of chain.onError) await hook(err, c);
  } catch (e2) {
    // onError сам бросил → последний рубеж.
    c.error = e2;
    defaultError(c, e2);
    return;
  }
  if (!c._finalized) defaultError(c, err);
}

/** Ядро: «до»-хуки → луковица; исключения → onError. Формирует c (не пишет ответ). */
async function runCore(chain, c) {
  try {
    for (const stage of BEFORE_STAGES) {
      if (c._finalized) break;
      await runBeforeHooks(chain[stage], c);
    }
    if (!c._finalized) await runOnion(chain.middleware, chain.handler, c);
  } catch (err) {
    await handleError(chain, c, err);
  }
}

/** Гонка ядра с таймаутом. По таймауту: abort сигнала → onTimeout → 504, латч ответа. */
function withTimeout(chain, c, ms, controller) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(async () => {
      c.aborted = true;
      try {
        controller.abort();
      } catch {
        // сигнал уже мог быть отменён
      }
      try {
        await runAfterHooks(chain.onTimeout, c);
      } catch (e) {
        c.error = e;
      }
      if (!c._finalized) c.text('Gateway Timeout', 504);
      c._settled = true; // латч: поздний результат ядра игнорируется мутаторами
      resolve();
    }, ms);
  });
  return Promise.race([runCore(chain, c), timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  buildChain,
  runCore,
  withTimeout,
  runAfterHooks,
  prefixMatches,
  BEFORE_STAGES,
  AFTER_STAGES,
  ALL_STAGES,
};
