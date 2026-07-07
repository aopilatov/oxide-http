//! Нативный CORS (§6a, §10-набор). Работает на краях в Rust: preflight `OPTIONS`
//! отвечается без пробуждения JS; `Access-Control-*` навешиваются на ответ.
//!
//! `origin` поддерживает `*` (любой) и список строк. Origin-функция не нативна
//! (это JS) — для неё пишется обычный JS-middleware.

/// Опции CORS с JS-стороны (нормализованы обёрткой).
pub struct CorsOptions {
    pub origins: Vec<String>, // ["*"] = любой
    pub methods: Vec<String>,
    pub allowed_headers: Option<Vec<String>>, // None = отражать запрошенные
    pub exposed_headers: Option<Vec<String>>,
    pub credentials: bool,
    pub max_age: Option<i64>, // секунды
}

/// Скомпилированная CORS-политика.
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

    /// Значение для `Access-Control-Allow-Origin`, если origin разрешён.
    /// С credentials `*` недопустим — отражаем конкретный origin.
    fn resolve_origin(&self, origin: Option<&str>) -> Option<String> {
        if self.any_origin {
            return if self.credentials {
                Some(origin.unwrap_or("*").to_string())
            } else {
                Some("*".to_string())
            };
        }
        match origin {
            Some(o) if self.origins.iter().any(|x| x == o) => Some(o.to_string()),
            _ => None,
        }
    }

    /// Заголовки preflight-ответа. `None` → origin запрещён (отклонить `403`).
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
        // allowedHeaders задан → он; иначе отражаем запрошенные.
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

    /// Заголовки для обычного (не preflight) ответа. Пусто, если origin не разрешён.
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
    fn any_origin_with_credentials_echoes() {
        let c = cors(&["*"], true);
        assert_eq!(
            c.resolve_origin(Some("https://x.com")).unwrap(),
            "https://x.com"
        );
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
