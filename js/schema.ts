// Schemas (§6b): the source is either valibot (converted to JSON Schema for Rust) or
// raw JSON Schema. Rust performs structural validation/coercion off the event loop;
// this module handles conversion, valibot transform/refine (preValidation) and
// response stripping.

/** Route schema: a valibot schema or raw JSON Schema. */
export type SchemaSource = ValibotSchema | JsonSchemaObject;

/** The minimal valibot schema shape we detect at runtime. */
export interface ValibotSchema {
  readonly '~standard'?: unknown;
  readonly kind?: string;
  readonly '~run'?: unknown;
}

/** The slice of JSON Schema we care about (everything else is left alone). */
export interface JsonSchemaObject {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A single validation problem in the `400` response format (§6b). */
export interface ValidationIssue {
  in: IssueLocation;
  path: string;
  message: string;
  code: string;
}

/** Where exactly the mismatch happened. */
export type IssueLocation = 'body' | 'query' | 'params';

/** The valibot issue shape we rely on. */
interface ValibotIssue {
  path?: ReadonlyArray<{ key?: unknown }>;
  message: string;
  type?: string;
}

/** The result of valibot's `safeParse`. */
interface ValibotParseResult {
  success: boolean;
  output?: unknown;
  issues?: ReadonlyArray<ValibotIssue>;
}

type ToJsonSchemaFn = (schema: unknown, opts: { errorMode: string }) => JsonSchemaObject;
type SafeParseFn = (schema: unknown, data: unknown) => ValibotParseResult;

// valibot and @valibot/to-json-schema are optional dependencies: without schemas they
// are not needed at all. They are loaded via a dynamic import() once per listen() (see
// `loadSchemaDeps`) rather than createRequire, because this module runs both as ESM
// (.ts directly during development) and as CJS (after the build), and `import.meta` is
// forbidden in CJS output.
let _toJsonSchema: ToJsonSchemaFn | undefined;
let _safeParse: SafeParseFn | undefined;

/** Load the valibot dependencies. Called from `listen()` when schemas are present. */
export async function loadSchemaDeps(): Promise<void> {
  if (_toJsonSchema && _safeParse) return;
  try {
    const [toJson, valibot] = await Promise.all([
      import('@valibot/to-json-schema'),
      import('valibot'),
    ]);
    // Deliberately narrow the third-party types to the minimal shape we need: we rely
    // only on the structural part of JSON Schema and on success/issues.
    _toJsonSchema = toJson.toJsonSchema as unknown as ToJsonSchemaFn;
    _safeParse = valibot.safeParse as unknown as SafeParseFn;
  } catch (cause) {
    throw new Error(
      'schema options require the valibot and @valibot/to-json-schema packages: ' +
        'npm i valibot @valibot/to-json-schema',
      { cause },
    );
  }
}

function requireDeps(): { toJsonSchema: ToJsonSchemaFn; safeParse: SafeParseFn } {
  if (!_toJsonSchema || !_safeParse) {
    throw new Error('internal error: loadSchemaDeps() was not called before using a schema');
  }
  return { toJsonSchema: _toJsonSchema, safeParse: _safeParse };
}

/** Is this a valibot schema? (Standard Schema / valibot's internal markers). */
export function isValibot(s: unknown): s is ValibotSchema {
  if (s == null || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return o['~standard'] != null || o['kind'] === 'schema' || typeof o['~run'] === 'function';
}

// errorMode:'ignore' — convert ONLY the structural part (types/min/max/...).
// transform/check do not map to JSON Schema (they are JS) — valibot applies them in
// preValidation.
const TO_JSON_OPTS = { errorMode: 'ignore' } as const;

/** Schema → JSON Schema string (the structural part, for Rust). */
export function toJsonSchemaString(schema: SchemaSource | null | undefined): string | undefined {
  if (schema == null) return undefined;
  if (isValibot(schema)) return JSON.stringify(valibotToJsonSchema(schema));
  // raw JSON Schema
  return JSON.stringify(schema);
}

function valibotToJsonSchema(schema: ValibotSchema): JsonSchemaObject {
  return requireDeps().toJsonSchema(schema, TO_JSON_OPTS);
}

/** The set of top-level property names (used for response stripping). */
export function topProps(schema: SchemaSource | null | undefined): Set<string> | null {
  if (schema == null) return null;
  const js = isValibot(schema) ? valibotToJsonSchema(schema) : schema;
  return js.properties ? new Set(Object.keys(js.properties)) : null;
}

/** valibot safeParse (for transform/refine during the preValidation stage). */
export function valibotSafeParse(schema: ValibotSchema, data: unknown): ValibotParseResult {
  return requireDeps().safeParse(schema, data);
}

/** valibot issues → a machine-readable list `[{ in, path, message, code }]`. */
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
