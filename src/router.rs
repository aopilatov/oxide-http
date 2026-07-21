//! Routing on `matchit` (radix tree). One tree per HTTP method plus a separate tree
//! for `ALL`. Matching and `params` extraction happen entirely in Rust (design §5).
//!
//! The public path syntax is Hono-like (`:id`, `*path`); internally it is translated
//! into matchit syntax (`{id}`, `{*path}`). The form `{id}.{ext}` (several parameters
//! in one segment) is passed through as-is.

use std::collections::HashMap;

use matchit::Router;

/// Route definition coming from the JS wrapper.
pub struct RouteDef {
    pub method: String,
    pub path: String,
    pub leaf_id: i32,
}

/// Compiled route trees (immutable after `build`).
pub struct Routes {
    /// method (UPPERCASE) -> tree
    by_method: HashMap<String, Router<i32>>,
    /// routes declared as `ALL` (fallback for any method)
    all: Option<Router<i32>>,
}

/// Match result: leaf id plus the extracted path parameters.
pub struct Matched {
    pub leaf_id: i32,
    pub params: HashMap<String, String>,
}

impl Routes {
    /// Build the trees from a flat list. A matchit error (conflict/invalid pattern)
    /// propagates upward and is surfaced from `listen()` to JS.
    pub fn build(defs: Vec<RouteDef>) -> Result<Self, String> {
        let mut by_method: HashMap<String, Router<i32>> = HashMap::new();
        let mut all: Option<Router<i32>> = None;

        for def in defs {
            let pattern = to_matchit(&def.path);
            let method = def.method.to_uppercase();
            let router = if method == "ALL" {
                all.get_or_insert_with(Router::new)
            } else {
                by_method.entry(method).or_default()
            };
            router
                .insert(pattern.clone(), def.leaf_id)
                .map_err(|e| format!("route {} {}: {e}", def.method, def.path))?;
        }

        Ok(Routes { by_method, all })
    }

    /// Match (method, path). The method-specific tree first, then `ALL`.
    pub fn match_route(&self, method: &str, path: &str) -> Option<Matched> {
        if let Some(router) = self.by_method.get(method) {
            if let Ok(m) = router.at(path) {
                return Some(to_matched(m));
            }
        }
        if let Some(router) = &self.all {
            if let Ok(m) = router.at(path) {
                return Some(to_matched(m));
            }
        }
        None
    }

    /// Methods under which this path exists (for `405`/`Allow` and auto-`OPTIONS`).
    /// An empty list ⇒ the path does not exist at all ⇒ `404`.
    ///
    /// Adds derived `HEAD` (when `GET` exists) and always `OPTIONS` (handled
    /// automatically). The result is sorted deterministically.
    pub fn allowed_methods(&self, path: &str) -> Vec<String> {
        let mut methods: Vec<String> = self
            .by_method
            .iter()
            .filter(|(_, r)| r.at(path).is_ok())
            .map(|(m, _)| m.clone())
            .collect();

        // ALL matches the path ⇒ every standard method is allowed.
        if self.all.as_ref().is_some_and(|r| r.at(path).is_ok()) {
            for m in ["GET", "POST", "PUT", "PATCH", "DELETE", "QUERY"] {
                if !methods.iter().any(|x| x == m) {
                    methods.push(m.to_string());
                }
            }
        }

        if methods.is_empty() {
            return methods; // path not found
        }

        if methods.iter().any(|m| m == "GET") && !methods.iter().any(|m| m == "HEAD") {
            methods.push("HEAD".to_string());
        }
        if !methods.iter().any(|m| m == "OPTIONS") {
            methods.push("OPTIONS".to_string());
        }
        methods.sort();
        methods
    }
}

fn to_matched(m: matchit::Match<'_, '_, &i32>) -> Matched {
    let params = m
        .params
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Matched {
        leaf_id: *m.value,
        params,
    }
}

/// Translate the public path syntax into matchit syntax.
/// `:name` → `{name}`, `*name`/`*` → `{*name}`/`{*wildcard}`, `{...}` passes through.
fn to_matchit(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    for (i, seg) in path.split('/').enumerate() {
        if i > 0 {
            out.push('/');
        }
        if seg.is_empty() {
            continue;
        }
        if let Some(rest) = seg.strip_prefix('*') {
            // catch-all (matchit requires a name)
            let name = if rest.is_empty() { "wildcard" } else { rest };
            out.push_str("{*");
            out.push_str(name);
            out.push('}');
        } else if seg.contains(':') {
            translate_colons(seg, &mut out);
        } else {
            out.push_str(seg);
        }
    }
    out
}

/// Replaces `:name` tokens with `{name}` inside a single segment
/// (supports several per segment, e.g. `:id.:ext` → `{id}.{ext}`).
fn translate_colons(seg: &str, out: &mut String) {
    let mut chars = seg.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ':' {
            out.push('{');
            while let Some(&nc) = chars.peek() {
                if nc.is_ascii_alphanumeric() || nc == '_' {
                    out.push(nc);
                    chars.next();
                } else {
                    break;
                }
            }
            out.push('}');
        } else {
            out.push(c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs(items: &[(&str, &str, i32)]) -> Vec<RouteDef> {
        items
            .iter()
            .map(|(m, p, id)| RouteDef {
                method: m.to_string(),
                path: p.to_string(),
                leaf_id: *id,
            })
            .collect()
    }

    #[test]
    fn translate_syntax() {
        assert_eq!(to_matchit("/users/:id"), "/users/{id}");
        assert_eq!(to_matchit("/static/*path"), "/static/{*path}");
        assert_eq!(to_matchit("/files/*"), "/files/{*wildcard}");
        assert_eq!(to_matchit("/{id}.{ext}"), "/{id}.{ext}");
        assert_eq!(to_matchit("/a/:x/b/:y"), "/a/{x}/b/{y}");
        assert_eq!(to_matchit("/"), "/");
        assert_eq!(to_matchit("/health"), "/health");
    }

    #[test]
    fn static_and_param() {
        let r = Routes::build(defs(&[("GET", "/users/:id", 0), ("GET", "/users/me", 1)])).unwrap();
        // static wins over param (matchit does this automatically)
        let m = r.match_route("GET", "/users/me").unwrap();
        assert_eq!(m.leaf_id, 1);
        let m = r.match_route("GET", "/users/42").unwrap();
        assert_eq!(m.leaf_id, 0);
        assert_eq!(m.params.get("id").unwrap(), "42");
    }

    #[test]
    fn multi_param_per_segment_rejected() {
        // matchit limitation: one parameter per segment. `{id}.{ext}` is rejected at
        // build time. The workaround is to match the whole segment and split in the handler.
        let result = Routes::build(defs(&[("GET", "/{id}.{ext}", 0)]));
        assert!(result.is_err());
    }

    #[test]
    fn whole_segment_param() {
        // Recommended workaround: `report.pdf` matches wholly into one parameter.
        let r = Routes::build(defs(&[("GET", "/files/:name", 0)])).unwrap();
        let m = r.match_route("GET", "/files/report.pdf").unwrap();
        assert_eq!(m.params.get("name").unwrap(), "report.pdf");
    }

    #[test]
    fn catch_all() {
        let r = Routes::build(defs(&[("GET", "/static/*path", 0)])).unwrap();
        let m = r.match_route("GET", "/static/css/app.css").unwrap();
        assert_eq!(m.leaf_id, 0);
        assert_eq!(m.params.get("path").unwrap(), "css/app.css");
    }

    #[test]
    fn not_found_and_method_not_allowed() {
        let r = Routes::build(defs(&[("GET", "/users", 0), ("POST", "/users", 1)])).unwrap();
        assert!(r.match_route("DELETE", "/users").is_none());
        // path exists, method does not ⇒ 405; Allow includes GET/POST + HEAD + OPTIONS
        let allowed = r.allowed_methods("/users");
        assert_eq!(allowed, vec!["GET", "HEAD", "OPTIONS", "POST"]);
        // the path does not exist at all ⇒ 404
        assert!(r.allowed_methods("/nope").is_empty());
    }

    #[test]
    fn all_method_fallback() {
        let r = Routes::build(defs(&[("ALL", "/any", 7)])).unwrap();
        assert_eq!(r.match_route("GET", "/any").unwrap().leaf_id, 7);
        assert_eq!(r.match_route("DELETE", "/any").unwrap().leaf_id, 7);
    }

    #[test]
    fn conflict_is_error() {
        let result = Routes::build(defs(&[("GET", "/x", 0), ("GET", "/x", 1)]));
        match result {
            Err(e) => assert!(e.contains("/x")),
            Ok(_) => panic!("expected a route conflict"),
        }
    }

    #[test]
    fn base_url_glued_paths_match() {
        // baseUrl is joined in JS: the route is registered as /api/v1/users/:id
        let r = Routes::build(defs(&[("GET", "/api/v1/users/:id", 0)])).unwrap();
        let m = r.match_route("GET", "/api/v1/users/9").unwrap();
        assert_eq!(m.params.get("id").unwrap(), "9");
    }
}
