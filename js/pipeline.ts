// Движок жизненного цикла запроса (§6, §6a): Koa-луковица middleware +
// Fastify-хуки. Цепочки предкомпилируются на listen() для каждого листа маршрута.
//
// Порядок: onRequest → preParsing → preValidation → preHandler →
//          [ЛУКОВИЦА middleware → ХЕНДЛЕР] → preSerialization → onSend → (write) → onResponse.
// Short-circuit: любой «до»-хук сформировал ответ → дальше не идём, но «после»-хуки идут всегда.
// Ошибка в любом слое → onError. onTimeout/onAbort — отдельные ветки.

import { HttpError, applyReturnValue } from './context.ts';
import type { Context } from './context.ts';

/** Хендлер маршрута: значение-возврат работает как сахар (§8). */
export type Handler = (c: Context) => unknown | Promise<unknown>;
/** Middleware-луковица. */
export type Middleware = (c: Context, next: () => Promise<void>) => unknown | Promise<unknown>;
/** Обычный хук жизненного цикла. */
export type Hook = (c: Context) => unknown | Promise<unknown>;
/** Хук обработки ошибки. */
export type ErrorHook = (err: unknown, c: Context) => unknown | Promise<unknown>;

/** Стадии, идущие до хендлера. */
export const BEFORE_STAGES = ['onRequest', 'preParsing', 'preValidation', 'preHandler'] as const;
/** Стадии, идущие после (выполняются всегда). */
export const AFTER_STAGES = ['preSerialization', 'onSend'] as const;
const OTHER_STAGES = [
  'onResponse',
  'onError',
  'onTimeout',
  'onAbort',
  'onConnect',
  'onClose',
] as const;
/** Все стадии жизненного цикла. */
export const ALL_STAGES = [...BEFORE_STAGES, ...AFTER_STAGES, ...OTHER_STAGES] as const;

/** Имя стадии жизненного цикла. */
export type StageName = (typeof ALL_STAGES)[number];
/** Стадия до хендлера. */
export type BeforeStage = (typeof BEFORE_STAGES)[number];

/** Middleware или хук с префиксом пути, на который он навешан. */
export interface Scoped<T> {
  prefix: string;
  fn: T;
}

/** Маршрут до предкомпиляции цепочки. */
export interface RouteDefinition {
  path: string;
  handler: Handler;
  middleware?: Middleware[];
  hooks?: Partial<Record<StageName, Array<Hook | ErrorHook>>>;
}

/** Предкомпилированная цепочка одного листа маршрута. */
export type Chain = {
  handler: Handler;
  middleware: Middleware[];
  onError: ErrorHook[];
} & { [K in Exclude<StageName, 'onError'>]: Hook[] };

/** Совпадает ли префикс middleware/хука с путём маршрута. */
export function prefixMatches(prefix: string, path: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(prefix + '/');
}

/** Предкомпиляция цепочки для одного маршрута: глобальные (по префиксу) + маршрутные. */
export function buildChain(
  route: RouteDefinition,
  globalMiddleware: Array<Scoped<Middleware>>,
  globalHooks: Record<StageName, Array<Scoped<Hook | ErrorHook>>>,
): Chain {
  const chain = {
    handler: route.handler,
    middleware: [
      ...globalMiddleware.filter((m) => prefixMatches(m.prefix, route.path)).map((m) => m.fn),
      ...(route.middleware ?? []),
    ],
  } as Chain;

  for (const stage of ALL_STAGES) {
    const globals = (globalHooks[stage] ?? [])
      .filter((h) => prefixMatches(h.prefix, route.path))
      .map((h) => h.fn);
    const routeLevel = route.hooks?.[stage] ?? [];
    // Стадии типизированы по-разному (onError принимает ошибку первым аргументом),
    // поэтому здесь единственное место с приведением: раскладываем по именам.
    (chain as Record<string, unknown>)[stage] = [...globals, ...routeLevel];
  }
  return chain;
}

/** Прогнать «до»-хуки стадии; short-circuit прерывает на первом сформировавшем ответ. */
async function runBeforeHooks(hooks: Hook[], c: Context): Promise<void> {
  for (const hook of hooks) {
    await hook(c);
    if (c._finalized) break;
  }
}

/** Прогнать «после»-хуки: идут все (могут дорабатывать ответ), ошибка всплывает. */
export async function runAfterHooks(hooks: Hook[], c: Context): Promise<void> {
  for (const hook of hooks) await hook(c);
}

/** Луковица: middleware `(c, next)` вокруг хендлера. */
async function runOnion(middleware: Middleware[], handler: Handler, c: Context): Promise<void> {
  let index = -1;
  const dispatch = async (i: number): Promise<void> => {
    if (i <= index) throw new Error('next() вызван несколько раз');
    index = i;
    const mw = middleware[i];
    if (mw !== undefined) {
      await mw(c, () => dispatch(i + 1));
    } else {
      const result = await handler(c);
      applyReturnValue(c, result);
    }
  };
  await dispatch(0);
}

/** Сформировать ответ по ошибке: onError-хуки → c.res, иначе дефолт по статусу. */
function defaultError(c: Context, err: unknown): void {
  if (err instanceof HttpError) c.text(err.message || 'Error', err.status);
  else c.text('Internal Server Error', 500);
}

async function handleError(chain: Chain, c: Context, err: unknown): Promise<void> {
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
export async function runCore(chain: Chain, c: Context): Promise<void> {
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
export function withTimeout(
  chain: Chain,
  c: Context,
  ms: number,
  controller: AbortController,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      void (async () => {
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
      })();
    }, ms);
  });
  return Promise.race([runCore(chain, c), timeout]).finally(() => clearTimeout(timer));
}
