// Схемы (§6b): источник — valibot (конвертируется в JSON Schema для Rust) либо
// сырой JSON Schema. Rust делает структурную валидацию/коэрцию вне event loop;
// здесь — конвертация, valibot transform/refine (preValidation) и стрип ответа.

/** Схема маршрута: valibot-схема либо сырой JSON Schema. */
export type SchemaSource = ValibotSchema | JsonSchemaObject;

/** Минимальная форма valibot-схемы, которую мы различаем на рантайме. */
export interface ValibotSchema {
  readonly '~standard'?: unknown;
  readonly kind?: string;
  readonly '~run'?: unknown;
}

/** Кусок JSON Schema, который нам нужен (остальное не трогаем). */
export interface JsonSchemaObject {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Одна проблема валидации в формате ответа `400` (§6b). */
export interface ValidationIssue {
  in: IssueLocation;
  path: string;
  message: string;
  code: string;
}

/** Где именно не сошлось. */
export type IssueLocation = 'body' | 'query' | 'params';

/** Форма issue от valibot, на которую мы опираемся. */
interface ValibotIssue {
  path?: ReadonlyArray<{ key?: unknown }>;
  message: string;
  type?: string;
}

/** Результат `safeParse` от valibot. */
interface ValibotParseResult {
  success: boolean;
  output?: unknown;
  issues?: ReadonlyArray<ValibotIssue>;
}

type ToJsonSchemaFn = (schema: unknown, opts: { errorMode: string }) => JsonSchemaObject;
type SafeParseFn = (schema: unknown, data: unknown) => ValibotParseResult;

// valibot и @valibot/to-json-schema — опциональные зависимости: без схем они не
// нужны вовсе. Грузим их динамическим import() один раз на listen() (см.
// `loadSchemaDeps`), а не через createRequire: модуль исполняется и как ESM
// (.ts напрямую в разработке), и как CJS (после сборки), а `import.meta`
// в CJS-выводе запрещён.
let _toJsonSchema: ToJsonSchemaFn | undefined;
let _safeParse: SafeParseFn | undefined;

/** Подгрузить valibot-зависимости. Зовётся из `listen()`, когда есть схемы. */
export async function loadSchemaDeps(): Promise<void> {
  if (_toJsonSchema && _safeParse) return;
  try {
    const [toJson, valibot] = await Promise.all([
      import('@valibot/to-json-schema'),
      import('valibot'),
    ]);
    // Намеренно сужаем сторонние типы до минимальной формы, которая нам нужна:
    // мы опираемся только на структурную часть JSON Schema и на success/issues.
    _toJsonSchema = toJson.toJsonSchema as unknown as ToJsonSchemaFn;
    _safeParse = valibot.safeParse as unknown as SafeParseFn;
  } catch (cause) {
    throw new Error(
      'для schema-опций нужны пакеты valibot и @valibot/to-json-schema: ' +
        'npm i valibot @valibot/to-json-schema',
      { cause },
    );
  }
}

function requireDeps(): { toJsonSchema: ToJsonSchemaFn; safeParse: SafeParseFn } {
  if (!_toJsonSchema || !_safeParse) {
    throw new Error('внутренняя ошибка: loadSchemaDeps() не был вызван до работы со схемой');
  }
  return { toJsonSchema: _toJsonSchema, safeParse: _safeParse };
}

/** valibot-схема? (Standard Schema / внутренние маркеры valibot). */
export function isValibot(s: unknown): s is ValibotSchema {
  if (s == null || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return o['~standard'] != null || o['kind'] === 'schema' || typeof o['~run'] === 'function';
}

// errorMode:'ignore' — конвертируем ТОЛЬКО структурную часть (типы/min/max/...).
// transform/check не мапятся в JSON Schema (это JS) — их доигрывает valibot в preValidation.
const TO_JSON_OPTS = { errorMode: 'ignore' } as const;

/** Схема → строка JSON Schema (структурная часть, для Rust). */
export function toJsonSchemaString(schema: SchemaSource | null | undefined): string | undefined {
  if (schema == null) return undefined;
  if (isValibot(schema)) return JSON.stringify(valibotToJsonSchema(schema));
  // сырой JSON Schema
  return JSON.stringify(schema);
}

function valibotToJsonSchema(schema: ValibotSchema): JsonSchemaObject {
  return requireDeps().toJsonSchema(schema, TO_JSON_OPTS);
}

/** Множество имён свойств верхнего уровня (для стрипа ответа). */
export function topProps(schema: SchemaSource | null | undefined): Set<string> | null {
  if (schema == null) return null;
  const js = isValibot(schema) ? valibotToJsonSchema(schema) : schema;
  return js.properties ? new Set(Object.keys(js.properties)) : null;
}

/** valibot safeParse (для transform/refine на стадии preValidation). */
export function valibotSafeParse(schema: ValibotSchema, data: unknown): ValibotParseResult {
  return requireDeps().safeParse(schema, data);
}

/** valibot issues → машиночитаемый список `[{ in, path, message, code }]`. */
export function valibotIssues(
  issues: ReadonlyArray<ValibotIssue>,
  location: IssueLocation,
): ValidationIssue[] {
  return issues.map((iss) => ({
    in: location,
    path: (iss.path ?? []).map((p) => String(p.key)).join('.'),
    message: iss.message,
    code: iss.type ?? 'invalid',
  }));
}
