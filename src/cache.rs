//! Native per-route response cache (§18).
//!
//! A route opts in with `cache: { ttl }`; the first request runs the JS handler and the
//! response is stored here. Until the TTL expires, identical requests are answered
//! entirely in Rust — JS never wakes, so hits run at native-endpoint speed.
//!
//! Only safe methods (`GET`, `HEAD`, `QUERY`) are served from the cache, and only
//! "plain" responses are stored: status 200, not streamed, no `Set-Cookie`, no
//! `Cache-Control: no-store/private`, body within `max_body_bytes`. The key is
//! method + path + query string (+ the raw body hash for `QUERY`) + the values of the
//! configured `vary` request headers.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bytes::Bytes;

use crate::bridge::{JsResponse, KvPair};

/// Per-route cache configuration (normalized by the JS wrapper).
pub struct CacheConfig {
    pub ttl: Duration,
    /// Request headers whose values join the key (already lowercase).
    pub vary: Vec<String>,
    /// Entry cap per route; above it expired entries are swept, then arbitrary ones.
    pub max_entries: usize,
    /// Responses with a larger body are not stored.
    pub max_body_bytes: usize,
}

/// A stored response.
struct Entry {
    /// The request path — kept so `purgeCache(path)` can match without parsing the key.
    path: String,
    status: u16,
    headers: Vec<(String, String)>,
    body: Bytes,
    expires: Instant,
}

/// A cache hit handed back to the dispatcher (`Bytes` clone is refcounted, not a copy).
pub struct Hit {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

/// The cache of one route leaf.
pub struct LeafCache {
    config: CacheConfig,
    store: Mutex<HashMap<String, Entry>>,
}

impl LeafCache {
    pub fn new(config: CacheConfig) -> Self {
        LeafCache {
            config,
            store: Mutex::new(HashMap::new()),
        }
    }

    /// Build the key for a request. `body_hash` is present only for `QUERY`.
    pub fn key(
        &self,
        method: &str,
        path: &str,
        query_string: Option<&str>,
        headers: &[KvPair],
        body_hash: Option<u64>,
    ) -> String {
        let mut key = String::with_capacity(64);
        key.push_str(method);
        key.push('\n');
        key.push_str(path);
        key.push('\n');
        if let Some(qs) = query_string {
            key.push_str(qs);
        }
        for name in &self.config.vary {
            key.push('\n');
            // Repeated headers join in order: a different set is a different variant.
            for kv in headers.iter().filter(|kv| &kv.key == name) {
                key.push_str(&kv.value);
                key.push('\x1f');
            }
        }
        if let Some(h) = body_hash {
            key.push('\n');
            key.push_str(&format!("{h:016x}"));
        }
        key
    }

    /// A live entry for the key, or `None` (an expired one is removed on the way).
    pub fn lookup(&self, key: &str) -> Option<Hit> {
        let mut store = self.store.lock().unwrap();
        match store.get(key) {
            Some(e) if e.expires > Instant::now() => Some(Hit {
                status: e.status,
                headers: e.headers.clone(),
                body: e.body.clone(),
            }),
            Some(_) => {
                store.remove(key);
                None
            }
            None => None,
        }
    }

    /// Store the JS response when it is eligible; a no-op otherwise.
    ///
    /// `request_id_header` is dropped from the stored copy: it belongs to the request
    /// that produced the entry, and the dispatcher stamps the current one on replay.
    pub fn maybe_store(
        &self,
        key: String,
        path: String,
        res: &JsResponse,
        request_id_header: &str,
    ) {
        if res.status.unwrap_or(200) != 200 || res.streamed.unwrap_or(false) {
            return;
        }
        let body_len = res.body.as_ref().map(|b| b.len()).unwrap_or(0);
        if body_len > self.config.max_body_bytes {
            return;
        }
        let mut headers = Vec::new();
        if let Some(pairs) = &res.headers {
            for kv in pairs {
                let name = kv.key.to_lowercase();
                if name == "set-cookie" {
                    return; // per-user data — never share it between clients
                }
                if name == "cache-control" {
                    let v = kv.value.to_lowercase();
                    if v.contains("no-store") || v.contains("private") {
                        return; // the handler explicitly opted this response out
                    }
                }
                if name == request_id_header {
                    continue;
                }
                headers.push((name, kv.value.clone()));
            }
        }

        let entry = Entry {
            path,
            status: res.status.unwrap_or(200),
            headers,
            body: Bytes::from(res.body.clone().unwrap_or_default()),
            expires: Instant::now() + self.config.ttl,
        };

        let mut store = self.store.lock().unwrap();
        if store.len() >= self.config.max_entries && !store.contains_key(&key) {
            // Sweep expired entries first; if the cap still holds, drop an arbitrary one
            // (plain rotation beats an LRU here: the cap is a memory guard, not a policy).
            let now = Instant::now();
            store.retain(|_, e| e.expires > now);
            if store.len() >= self.config.max_entries {
                if let Some(k) = store.keys().next().cloned() {
                    store.remove(&k);
                }
            }
        }
        store.insert(key, entry);
    }

    /// Remove entries: all of them, or those produced under the exact `path`.
    /// Returns how many were removed.
    pub fn purge(&self, path: Option<&str>) -> usize {
        let mut store = self.store.lock().unwrap();
        match path {
            None => {
                let n = store.len();
                store.clear();
                n
            }
            Some(p) => {
                let before = store.len();
                store.retain(|_, e| e.path != p);
                before - store.len()
            }
        }
    }
}

/// Hash of the raw request body (for the `QUERY` key).
pub fn hash_bytes(data: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(ttl_ms: u64, max_entries: usize) -> CacheConfig {
        CacheConfig {
            ttl: Duration::from_millis(ttl_ms),
            vary: vec![],
            max_entries,
            max_body_bytes: 1024 * 1024,
        }
    }

    fn ok_response(body: &str) -> JsResponse {
        JsResponse {
            status: Some(200),
            headers: Some(vec![KvPair {
                key: "content-type".into(),
                value: "application/json".into(),
            }]),
            body: Some(body.to_string()),
            streamed: None,
        }
    }

    #[test]
    fn store_and_hit() {
        let c = LeafCache::new(config(10_000, 16));
        let key = c.key("GET", "/a", None, &[], None);
        assert!(c.lookup(&key).is_none());
        c.maybe_store(key.clone(), "/a".into(), &ok_response("x"), "x-request-id");
        let hit = c.lookup(&key).expect("hit");
        assert_eq!(hit.status, 200);
        assert_eq!(&hit.body[..], b"x");
    }

    #[test]
    fn ttl_expires() {
        let c = LeafCache::new(config(0, 16));
        let key = c.key("GET", "/a", None, &[], None);
        c.maybe_store(key.clone(), "/a".into(), &ok_response("x"), "x-request-id");
        assert!(c.lookup(&key).is_none());
    }

    #[test]
    fn set_cookie_and_no_store_skip() {
        let c = LeafCache::new(config(10_000, 16));
        let key = c.key("GET", "/a", None, &[], None);
        let mut res = ok_response("x");
        res.headers.as_mut().unwrap().push(KvPair {
            key: "set-cookie".into(),
            value: "sid=1".into(),
        });
        c.maybe_store(key.clone(), "/a".into(), &res, "x-request-id");
        assert!(c.lookup(&key).is_none());

        let mut res = ok_response("x");
        res.headers.as_mut().unwrap().push(KvPair {
            key: "cache-control".into(),
            value: "no-store".into(),
        });
        c.maybe_store(key.clone(), "/a".into(), &res, "x-request-id");
        assert!(c.lookup(&key).is_none());
    }

    #[test]
    fn non_200_and_streamed_skip() {
        let c = LeafCache::new(config(10_000, 16));
        let key = c.key("GET", "/a", None, &[], None);
        let mut res = ok_response("x");
        res.status = Some(404);
        c.maybe_store(key.clone(), "/a".into(), &res, "x-request-id");
        assert!(c.lookup(&key).is_none());

        let mut res = ok_response("x");
        res.streamed = Some(true);
        c.maybe_store(key.clone(), "/a".into(), &res, "x-request-id");
        assert!(c.lookup(&key).is_none());
    }

    #[test]
    fn vary_separates_entries() {
        let c = LeafCache::new(CacheConfig {
            ttl: Duration::from_millis(10_000),
            vary: vec!["x-tenant".into()],
            max_entries: 16,
            max_body_bytes: 1024,
        });
        let ha = [KvPair {
            key: "x-tenant".into(),
            value: "a".into(),
        }];
        let hb = [KvPair {
            key: "x-tenant".into(),
            value: "b".into(),
        }];
        let ka = c.key("GET", "/a", None, &ha, None);
        let kb = c.key("GET", "/a", None, &hb, None);
        assert_ne!(ka, kb);
    }

    #[test]
    fn entry_cap_holds() {
        let c = LeafCache::new(config(10_000, 2));
        for i in 0..5 {
            let key = c.key("GET", &format!("/{i}"), None, &[], None);
            c.maybe_store(key, format!("/{i}"), &ok_response("x"), "x-request-id");
        }
        assert!(c.store.lock().unwrap().len() <= 2);
    }

    #[test]
    fn purge_by_path_and_all() {
        let c = LeafCache::new(config(10_000, 16));
        for (path, qs) in [("/a", Some("v=1")), ("/a", Some("v=2")), ("/b", None)] {
            let key = c.key("GET", path, qs, &[], None);
            c.maybe_store(key, path.into(), &ok_response("x"), "x-request-id");
        }
        assert_eq!(c.purge(Some("/a")), 2);
        assert_eq!(c.purge(None), 1);
    }

    #[test]
    fn request_id_is_dropped_from_stored_headers() {
        let c = LeafCache::new(config(10_000, 16));
        let key = c.key("GET", "/a", None, &[], None);
        let mut res = ok_response("x");
        res.headers.as_mut().unwrap().push(KvPair {
            key: "x-request-id".into(),
            value: "old".into(),
        });
        c.maybe_store(key.clone(), "/a".into(), &res, "x-request-id");
        let hit = c.lookup(&key).unwrap();
        assert!(hit.headers.iter().all(|(k, _)| k != "x-request-id"));
    }
}
