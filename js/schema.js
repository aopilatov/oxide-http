'use strict';

// Схемы (§6b): источник — valibot (конвертируется в JSON Schema для Rust) либо
// сырой JSON Schema. Rust делает структурную валидацию/коэрцию вне event loop;
// здесь — конвертация, valibot transform/refine (preValidation) и стрип ответа.

let _toJsonSchema; // ленивая загрузка @valibot/to-json-schema
let _valibot; // ленивая загрузка valibot

/** valibot-схема? (Standard Schema / внутренние маркеры valibot). */
function isValibot(s) {
  return (
    s != null &&
    typeof s === 'object' &&
    (s['~standard'] != null || s.kind === 'schema' || typeof s['~run'] === 'function')
  );
}

// errorMode:'ignore' — конвертируем ТОЛЬКО структурную часть (типы/min/max/...).
// transform/check не мапятся в JSON Schema (это JS) — их доигрывает valibot в preValidation.
const TO_JSON_OPTS = { errorMode: 'ignore' };

/** Схема → строка JSON Schema (структурная часть, для Rust). */
function toJsonSchemaString(schema) {
  if (schema == null) return undefined;
  if (isValibot(schema)) return JSON.stringify(valibotToJsonSchema(schema));
  // сырой JSON Schema
  return JSON.stringify(schema);
}

function valibotToJsonSchema(schema) {
  if (!_toJsonSchema) _toJsonSchema = require('@valibot/to-json-schema').toJsonSchema;
  return _toJsonSchema(schema, TO_JSON_OPTS);
}

/** Множество имён свойств верхнего уровня (для стрипа ответа). */
function topProps(schema) {
  if (schema == null) return null;
  const js = isValibot(schema) ? jsonSchemaObject(schema) : schema;
  return js && js.properties ? new Set(Object.keys(js.properties)) : null;
}

function jsonSchemaObject(valibotSchema) {
  return valibotToJsonSchema(valibotSchema);
}

/** valibot safeParse (для transform/refine на стадии preValidation). */
function valibotSafeParse(schema, data) {
  if (!_valibot) _valibot = require('valibot');
  return _valibot.safeParse(schema, data);
}

/** valibot issues → машиночитаемый список [{ in, path, message, code }]. */
function valibotIssues(issues, location) {
  return issues.map((iss) => ({
    in: location,
    path: (iss.path ?? []).map((p) => p.key).join('.'),
    message: iss.message,
    code: iss.type ?? 'invalid',
  }));
}

module.exports = { isValibot, toJsonSchemaString, topProps, valibotSafeParse, valibotIssues };
