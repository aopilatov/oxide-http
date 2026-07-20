// Request lifecycle engine (§6, §6a): a Koa-style middleware onion plus Fastify-style
// hooks. Chains are precompiled on listen() for every route leaf.
//
// Order: onRequest → preParsing → preValidation → preHandler →
//        [MIDDLEWARE ONION → HANDLER] → preSerialization → onSend → (write) → onResponse.
// Short-circuit: if any "before" hook produced a response we stop there, but the
// "after" hooks always run. An error in any layer → onError. onTimeout/onAbort are
// separate branches.

import { HttpError, applyReturnValue } from './context.ts';
import type { Context } from './context.ts';

/** Route handler: the returned value works as sugar (§8). */
export type Handler = (c: Context) => unknown | Promise<unknown>;
/** Onion middleware. */
export type Middleware = (c: Context, next: () => Promise<void>) => unknown | Promise<unknown>;
/** A regular lifecycle hook. */
export type Hook = (c: Context) => unknown | Promise<unknown>;
/** An error handling hook. */
export type ErrorHook = (err: unknown, c: Context) => unknown | Promise<unknown>;

/** Stages that run before the handler. */
export const BEFORE_STAGES = ['onRequest', 'preParsing', 'preValidation', 'preHandler'] as const;
/** Stages that run after (always executed). */
export const AFTER_STAGES = ['preSerialization', 'onSend'] as const;
// No onConnect/onClose: connection-level hooks would mean waking JS once per connection,
// which is precisely what serving connections in Rust avoids. They were registrable but
// never fired, so they are gone rather than silently inert.
const OTHER_STAGES = ['onResponse', 'onError', 'onTimeout', 'onAbort'] as const;
/** All lifecycle stages. */
export const ALL_STAGES = [...BEFORE_STAGES, ...AFTER_STAGES, ...OTHER_STAGES] as const;

/** A lifecycle stage name. */
export type StageName = (typeof ALL_STAGES)[number];
/** A stage before the handler. */
export type BeforeStage = (typeof BEFORE_STAGES)[number];

/** A middleware or hook together with the path prefix it is mounted on. */
export interface Scoped<T> {
  prefix: string;
  fn: T;
}

/** A route before its chain is precompiled. */
export interface RouteDefinition {
  path: string;
  handler: Handler;
  middleware?: Middleware[];
  hooks?: Partial<Record<StageName, Array<Hook | ErrorHook>>>;
}

/** The precompiled chain of a single route leaf. */
export type Chain = {
  handler: Handler;
  middleware: Middleware[];
  onError: ErrorHook[];
} & { [K in Exclude<StageName, 'onError'>]: Hook[] };

/** Whether a middleware/hook prefix matches the route path. */
export function prefixMatches(prefix: string, path: string): boolean {
  return prefix === '' || path === prefix || path.startsWith(prefix + '/');
}

/** Precompile the chain for one route: globals (by prefix) plus route-level ones. */
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
    // The stages are typed differently (onError takes the error as its first argument),
    // so this is the single place with a cast: we assign them by name.
    (chain as Record<string, unknown>)[stage] = [...globals, ...routeLevel];
  }
  return chain;
}

/** Run a stage's "before" hooks; short-circuit stops at the first one that responds. */
async function runBeforeHooks(hooks: Hook[], c: Context): Promise<void> {
  for (const hook of hooks) {
    await hook(c);
    if (c._finalized) break;
  }
}

/** Run the "after" hooks: all of them run (they may refine the response); errors bubble. */
export async function runAfterHooks(hooks: Hook[], c: Context): Promise<void> {
  for (const hook of hooks) await hook(c);
}

/** The onion: middleware `(c, next)` wrapped around the handler. */
async function runOnion(middleware: Middleware[], handler: Handler, c: Context): Promise<void> {
  let index = -1;
  const dispatch = async (i: number): Promise<void> => {
    if (i <= index) throw new Error('next() called multiple times');
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

/** Build the error response: onError hooks → c.res, otherwise the status default. */
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
    // onError itself threw → last line of defence.
    c.error = e2;
    defaultError(c, e2);
    return;
  }
  if (!c._finalized) defaultError(c, err);
}

/** Core: "before" hooks → onion; exceptions → onError. Fills in c (does not write). */
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

/** Race the core against a timeout. On timeout: abort the signal → onTimeout → 504,
 *  then latch the response. */
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
          // the signal may already have been aborted
        }
        try {
          await runAfterHooks(chain.onTimeout, c);
        } catch (e) {
          c.error = e;
        }
        if (!c._finalized) c.text('Gateway Timeout', 504);
        c._settled = true; // latch: a late core result is ignored by the mutators
        resolve();
      })();
    }, ms);
  });
  return Promise.race([runCore(chain, c), timeout]).finally(() => clearTimeout(timer));
}
