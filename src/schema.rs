//! Нативная валидация по JSON Schema (§6b). Компиляция валидаторов на `listen()`,
//! структурная проверка body/query/params **вне event loop** → `400` без JS.
//!
//! Источник схем — valibot (конвертируется в JSON Schema обёрткой) либо сырой
//! JSON Schema. Коэрция query/params (всегда строки) по типам из схемы.

use std::collections::HashMap;

use jsonschema::{validator_for, Validator};
use serde_json::{json, Map, Value};

use crate::bridge::KvPair;

/// Схемы одного маршрута (скомпилированы). Любое поле может отсутствовать.
#[derive(Default)]
pub struct LeafSchema {
    body: Option<Validator>,
    query: Option<Compiled>,
    params: Option<Compiled>,
}

/// Валидатор + исходная схема (схема нужна для коэрции строк по типам).
struct Compiled {
    validator: Validator,
    schema: Value,
}

/// Ошибка валидации для машиночитаемого ответа `400`.
#[derive(Debug)]
pub struct Issue {
    pub location: &'static str, // "body" | "query" | "params"
    pub path: String,
    pub message: String,
    pub code: String,
}

/// Определение схем маршрута из JS (JSON Schema как строки).
pub struct SchemaDef {
    pub body: Option<String>,
    pub query: Option<String>,
    pub params: Option<String>,
}

/// Результат успешной валидации: коэрцированные/провалидированные значения (JSON-строки для JS).
#[derive(Default, Debug)]
pub struct Validated {
    pub body: Option<String>,
    pub query: Option<String>,
    pub params: Option<String>,
}

fn compile(src: Option<String>) -> Result<Option<Compiled>, String> {
    let Some(s) = src else { return Ok(None) };
    let schema: Value =
        serde_json::from_str(&s).map_err(|e| format!("невалидная JSON Schema: {e}"))?;
    let validator = validator_for(&schema).map_err(|e| format!("компиляция схемы: {e}"))?;
    Ok(Some(Compiled { validator, schema }))
}

impl LeafSchema {
    pub fn build(def: SchemaDef) -> Result<Self, String> {
        Ok(LeafSchema {
            body: compile(def.body)?.map(|c| c.validator),
            query: compile(def.query)?,
            params: compile(def.params)?,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.body.is_none() && self.query.is_none() && self.params.is_none()
    }

    pub fn has_body(&self) -> bool {
        self.body.is_some()
    }

    /// Коэрция + валидация query/params и (если задано тело) валидация body.
    /// `Ok(Validated)` — всё валидно; `Err(issues)` — список ошибок для `400`.
    pub fn validate(
        &self,
        query: &[KvPair],
        params: &HashMap<String, String>,
        body: Option<&[u8]>,
    ) -> Result<Validated, Vec<Issue>> {
        let mut issues = Vec::new();
        let mut out = Validated::default();

        if let Some(c) = &self.query {
            let value = coerce_query(query, &c.schema);
            collect(&c.validator, &value, "query", &mut issues);
            out.query = Some(value.to_string());
        }

        if let Some(c) = &self.params {
            let value = coerce_params(params, &c.schema);
            collect(&c.validator, &value, "params", &mut issues);
            out.params = Some(value.to_string());
        }

        if let Some(v) = &self.body {
            match body {
                Some(bytes) => match serde_json::from_slice::<Value>(bytes) {
                    Ok(value) => {
                        collect(v, &value, "body", &mut issues);
                        out.body = Some(value.to_string());
                    }
                    Err(e) => issues.push(Issue {
                        location: "body",
                        path: String::new(),
                        message: format!("невалидный JSON: {e}"),
                        code: "invalid_json".into(),
                    }),
                },
                None => issues.push(Issue {
                    location: "body",
                    path: String::new(),
                    message: "тело обязательно".into(),
                    code: "required".into(),
                }),
            }
        }

        if issues.is_empty() {
            Ok(out)
        } else {
            Err(issues)
        }
    }
}

fn collect(validator: &Validator, instance: &Value, location: &'static str, out: &mut Vec<Issue>) {
    for e in validator.iter_errors(instance) {
        out.push(Issue {
            location,
            path: pointer_to_path(&e.instance_path().to_string()),
            message: e.to_string(),
            code: kind_code(&format!("{:?}", e.kind())),
        });
    }
}

/// "/user/age" → "user.age"; "" → "".
fn pointer_to_path(ptr: &str) -> String {
    ptr.trim_start_matches('/').replace('/', ".")
}

/// Короткий код ошибки из Debug-имени варианта kind ("Type {..}" → "type").
fn kind_code(dbg: &str) -> String {
    dbg.split([' ', '(', '{'])
        .next()
        .unwrap_or("invalid")
        .to_lowercase()
}

fn coerce_query(pairs: &[KvPair], schema: &Value) -> Value {
    let props = schema.get("properties");
    let mut map = Map::new();
    // last-wins (как c.req.query)
    for kv in pairs {
        let prop = props.and_then(|p| p.get(&kv.key));
        map.insert(kv.key.clone(), coerce_scalar(&kv.value, prop));
    }
    Value::Object(map)
}

fn coerce_params(params: &HashMap<String, String>, schema: &Value) -> Value {
    let props = schema.get("properties");
    let mut map = Map::new();
    for (k, v) in params {
        let prop = props.and_then(|p| p.get(k));
        map.insert(k.clone(), coerce_scalar(v, prop));
    }
    Value::Object(map)
}

/// Строку → number/integer/boolean по типу из схемы. Не распарсилось → оставляем
/// строку (валидатор затем отметит несоответствие типа).
fn coerce_scalar(raw: &str, prop_schema: Option<&Value>) -> Value {
    let ty = prop_schema
        .and_then(|s| s.get("type"))
        .and_then(|t| t.as_str());
    match ty {
        Some("integer") => raw
            .parse::<i64>()
            .map(|n| json!(n))
            .unwrap_or_else(|_| json!(raw)),
        Some("number") => raw
            .parse::<f64>()
            .map(|n| json!(n))
            .unwrap_or_else(|_| json!(raw)),
        Some("boolean") => match raw {
            "true" => json!(true),
            "false" => json!(false),
            _ => json!(raw),
        },
        _ => json!(raw),
    }
}

/// Собрать тело ответа `400` из списка issues (машиночитаемо).
pub fn errors_body(issues: &[Issue]) -> String {
    let arr: Vec<Value> = issues
        .iter()
        .map(|i| json!({ "in": i.location, "path": i.path, "message": i.message, "code": i.code }))
        .collect();
    json!({ "error": "validation", "issues": arr }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kv(pairs: &[(&str, &str)]) -> Vec<KvPair> {
        pairs
            .iter()
            .map(|(k, v)| KvPair {
                key: k.to_string(),
                value: v.to_string(),
            })
            .collect()
    }

    fn leaf(body: Option<&str>, query: Option<&str>) -> LeafSchema {
        LeafSchema::build(SchemaDef {
            body: body.map(String::from),
            query: query.map(String::from),
            params: None,
        })
        .unwrap()
    }

    #[test]
    fn query_coercion_and_valid() {
        let s = leaf(
            None,
            Some(r#"{"type":"object","properties":{"age":{"type":"integer"}}}"#),
        );
        let out = s
            .validate(&kv(&[("age", "42")]), &HashMap::new(), None)
            .unwrap();
        assert_eq!(out.query.unwrap(), r#"{"age":42}"#); // строка → число
    }

    #[test]
    fn query_type_mismatch_400() {
        let s = leaf(
            None,
            Some(r#"{"type":"object","properties":{"age":{"type":"integer"}}}"#),
        );
        let err = s
            .validate(&kv(&[("age", "notnum")]), &HashMap::new(), None)
            .unwrap_err();
        assert_eq!(err[0].location, "query");
        assert_eq!(err[0].path, "age");
    }

    #[test]
    fn body_required_field_400() {
        let schema =
            r#"{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}"#;
        let s = leaf(Some(schema), None);
        let err = s.validate(&[], &HashMap::new(), Some(b"{}")).unwrap_err();
        assert_eq!(err[0].location, "body");
        assert_eq!(err[0].code, "required");
    }

    #[test]
    fn body_valid_passes_through() {
        let schema =
            r#"{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}"#;
        let s = leaf(Some(schema), None);
        let out = s
            .validate(&[], &HashMap::new(), Some(br#"{"name":"Bob"}"#))
            .unwrap();
        assert!(out.body.is_some());
    }

    #[test]
    fn invalid_json_body_400() {
        let s = leaf(Some(r#"{"type":"object"}"#), None);
        let err = s.validate(&[], &HashMap::new(), Some(b"{bad")).unwrap_err();
        assert_eq!(err[0].code, "invalid_json");
    }
}
