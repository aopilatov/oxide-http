//! Native CORS (§6a, §10 set). Runs at the edge in Rust: preflight `OPTIONS`
//! is answered without waking JS; `Access-Control-*` are attached to the response.
//!
//! `origin` supports `*` (any) and a list of strings. An origin function is not
//! native (that's JS) — write a regular JS middleware for it.

/// CORS options from the JS side (normalized by the wrapper).
pub struct CorsOptions {
    pub origins: Vec<String>, // ["*"] = any
    pub methods: Vec<String>,
    pub allowed_headers: Option<Vec<String>>, // None = reflect the requested ones
    pub exposed_headers: Option<Vec<String>>,
    pub credentials: bool,
    pub max_age: Option<i64>, // seconds
}

/// Compiled CORS policy.
pub struct Cors {
    any_origin: bool,
    origins: Vec<String>,
    methods: String,
    allowed_headers: Option<String>,
    exposed_headers: Option<String>,
    credentials: bool,
    max_age: Option<String>,
}

impl Cors {
    pub fn new(o: CorsOptions) -> Self {
        let any_origin = o.origins.iter().any(|x| x == "*");
        Cors {
            any_origin,
            origins: o.origins,
            methods: o.methods.join(", "),
            allowed_headers: o.allowed_headers.map(|v| v.join(", ")),
            exposed_headers: o.exposed_headers.map(|v| v.join(", ")),
            credentials: o.credentials,
            max_age: o.max_age.map(|n| n.to_string()),
        }
    }

    /// Value for `Access-Control-Allow-Origin` if the origin is allowed.
    ///
    /// `*` together with credentials is refused rather than reflected: reflecting turns
    /// "any origin" into "every origin may send cookies and read the reply", which
    /// removes the Same-Origin Policy entirely. The JS wrapper rejects that combination
    /// at config time; this is the defence in depth for a direct native call.
    fn resolve_origin(&self, origin: Option<&str>) -> Option<String> {
        if self.any_origin {
            return if self.credentials {
                None
            } else {
                Some("*".to_string())
            };
        }
        match origin {
            Some(o) if self.origins.iter().any(|x| x == o) => Some(o.to_string()),
            _ => None,
        }
    }

    /// Preflight response headers. `None` → origin rejected (respond `403`).
    pub fn preflight(
        &self,
        origin: Option<&str>,
        req_headers: Option<&str>,
    ) -> Option<Vec<(String, String)>> {
        let acao = self.resolve_origin(origin)?;
        let mut h = vec![
            ("access-control-allow-origin".into(), acao),
            ("access-control-allow-methods".into(), self.methods.clone()),
        ];
        // allowedHeaders set → use it; otherwise reflect the requested ones.
        let ah = self
            .allowed_headers
            .clone()
            .or_else(|| req_headers.map(|s| s.to_string()));
        if let Some(ah) = ah {
            h.push(("access-control-allow-headers".into(), ah));
        }
        if let Some(ma) = &self.max_age {
            h.push(("access-control-max-age".into(), ma.clone()));
        }
        if self.credentials {
            h.push(("access-control-allow-credentials".into(), "true".into()));
        }
        if !self.any_origin {
            h.push(("vary".into(), "origin".into()));
        }
        Some(h)
    }

    /// Headers for a regular (non-preflight) response. Empty if the origin is not allowed.
    pub fn actual(&self, origin: Option<&str>) -> Vec<(String, String)> {
        let Some(acao) = self.resolve_origin(origin) else {
            return vec![];
        };
        let mut h = vec![("access-control-allow-origin".into(), acao)];
        if self.credentials {
            h.push(("access-control-allow-credentials".into(), "true".into()));
        }
        if let Some(eh) = &self.exposed_headers {
            h.push(("access-control-expose-headers".into(), eh.clone()));
        }
        if !self.any_origin {
            h.push(("vary".into(), "origin".into()));
        }
        h
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cors(origins: &[&str], credentials: bool) -> Cors {
        Cors::new(CorsOptions {
            origins: origins.iter().map(|s| s.to_string()).collect(),
            methods: vec!["GET".into(), "POST".into()],
            allowed_headers: None,
            exposed_headers: None,
            credentials,
            max_age: Some(600),
        })
    }

    #[test]
    fn any_origin_star() {
        let c = cors(&["*"], false);
        assert_eq!(c.resolve_origin(Some("https://x.com")).unwrap(), "*");
        assert_eq!(c.actual(Some("https://x.com"))[0].1, "*");
    }

    #[test]
    fn any_origin_with_credentials_is_refused() {
        // Reflecting here would let any site issue credentialed requests and read the
        // reply. The wrapper rejects the config; native must not fall back to reflecting.
        let c = cors(&["*"], true);
        assert!(c.resolve_origin(Some("https://x.com")).is_none());
        assert!(c.preflight(Some("https://x.com"), None).is_none());
        assert!(c.actual(Some("https://x.com")).is_empty());
    }

    #[test]
    fn list_allows_and_rejects() {
        let c = cors(&["https://ok.com"], false);
        assert!(c.preflight(Some("https://ok.com"), None).is_some());
        assert!(c.preflight(Some("https://evil.com"), None).is_none());
        assert!(c.actual(Some("https://evil.com")).is_empty());
    }

    #[test]
    fn preflight_reflects_requested_headers() {
        let c = cors(&["*"], false);
        let h = c
            .preflight(Some("https://x.com"), Some("x-custom, authorization"))
            .unwrap();
        let ah = h
            .iter()
            .find(|(k, _)| k == "access-control-allow-headers")
            .unwrap();
        assert_eq!(ah.1, "x-custom, authorization");
    }
}
