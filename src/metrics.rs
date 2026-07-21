//! Prometheus-format metrics (§11).
//!
//! Everything is lock-free atomics: counters live in fixed-size arrays
//! (method × status class), the histogram is an array of buckets + sum + count.
//! No allocations and no `Mutex` on the hot request path.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

/// Methods with their own counters; everything else falls into `other`.
const METHODS: [&str; 9] = [
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "QUERY", "other",
];
const OTHER_METHOD: usize = 8;

/// Status classes: 1xx..5xx.
const CLASSES: [&str; 5] = ["1xx", "2xx", "3xx", "4xx", "5xx"];

/// Latency histogram bucket bounds in seconds (mirrors the Prometheus default).
const BUCKETS: [f64; 12] = [
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// Process metrics registry. One per server, shared via `Arc<Shared>`.
pub struct Metrics {
    /// Requests: [method][status class].
    requests: [[AtomicU64; CLASSES.len()]; METHODS.len()],
    /// Latency histogram: per-bucket counters + sum + total.
    duration_buckets: [AtomicU64; BUCKETS.len()],
    duration_sum_micros: AtomicU64,
    duration_count: AtomicU64,
    /// Requests being handled right now.
    in_flight: AtomicI64,
    /// Open connections.
    connections: AtomicI64,
    /// Body bytes read/written.
    request_bytes: AtomicU64,
    response_bytes: AtomicU64,
    /// Native response cache (§18): hits answered in Rust / misses that ran JS.
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
}

impl Default for Metrics {
    fn default() -> Self {
        Metrics::new()
    }
}

impl Metrics {
    pub fn new() -> Self {
        Metrics {
            requests: Default::default(),
            duration_buckets: Default::default(),
            duration_sum_micros: AtomicU64::new(0),
            duration_count: AtomicU64::new(0),
            in_flight: AtomicI64::new(0),
            connections: AtomicI64::new(0),
            request_bytes: AtomicU64::new(0),
            response_bytes: AtomicU64::new(0),
            cache_hits: AtomicU64::new(0),
            cache_misses: AtomicU64::new(0),
        }
    }

    pub fn conn_opened(&self) {
        self.connections.fetch_add(1, Ordering::Relaxed);
    }
    pub fn conn_closed(&self) {
        self.connections.fetch_sub(1, Ordering::Relaxed);
    }
    pub fn request_started(&self) {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
    }
    pub fn add_request_bytes(&self, n: u64) {
        self.request_bytes.fetch_add(n, Ordering::Relaxed);
    }
    pub fn add_response_bytes(&self, n: u64) {
        self.response_bytes.fetch_add(n, Ordering::Relaxed);
    }
    pub fn cache_hit(&self) {
        self.cache_hits.fetch_add(1, Ordering::Relaxed);
    }
    pub fn cache_miss(&self) {
        self.cache_misses.fetch_add(1, Ordering::Relaxed);
    }

    /// Request finished: drop in-flight, fold into counters and the histogram.
    pub fn request_finished(&self, method: &str, status: u16, elapsed: std::time::Duration) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);

        let m = method_index(method);
        let c = class_index(status);
        self.requests[m][c].fetch_add(1, Ordering::Relaxed);

        let secs = elapsed.as_secs_f64();
        for (i, edge) in BUCKETS.iter().enumerate() {
            if secs <= *edge {
                // The cumulative "le" semantics are built at render time; here we
                // only bump the first matching bucket.
                self.duration_buckets[i].fetch_add(1, Ordering::Relaxed);
                break;
            }
        }
        self.duration_sum_micros
            .fetch_add(elapsed.as_micros() as u64, Ordering::Relaxed);
        self.duration_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Prometheus text format (exposition format 0.0.4).
    pub fn encode(&self) -> String {
        let mut out = String::with_capacity(2048);

        out.push_str("# HELP http_requests_total Total HTTP requests handled.\n");
        out.push_str("# TYPE http_requests_total counter\n");
        for (mi, method) in METHODS.iter().enumerate() {
            for (ci, class) in CLASSES.iter().enumerate() {
                let v = self.requests[mi][ci].load(Ordering::Relaxed);
                if v == 0 {
                    continue; // do not clutter the output with zeros
                }
                out.push_str(&format!(
                    "http_requests_total{{method=\"{method}\",status=\"{class}\"}} {v}\n"
                ));
            }
        }

        out.push_str("# HELP http_request_duration_seconds Request handling latency.\n");
        out.push_str("# TYPE http_request_duration_seconds histogram\n");
        let mut cumulative = 0u64;
        for (i, edge) in BUCKETS.iter().enumerate() {
            cumulative += self.duration_buckets[i].load(Ordering::Relaxed);
            out.push_str(&format!(
                "http_request_duration_seconds_bucket{{le=\"{edge}\"}} {cumulative}\n"
            ));
        }
        let count = self.duration_count.load(Ordering::Relaxed);
        let sum = self.duration_sum_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0;
        out.push_str(&format!(
            "http_request_duration_seconds_bucket{{le=\"+Inf\"}} {count}\n"
        ));
        out.push_str(&format!("http_request_duration_seconds_sum {sum}\n"));
        out.push_str(&format!("http_request_duration_seconds_count {count}\n"));

        let gauges = [
            (
                "http_requests_in_flight",
                "Requests currently being handled.",
                self.in_flight.load(Ordering::Relaxed),
            ),
            (
                "http_connections_active",
                "Open connections.",
                self.connections.load(Ordering::Relaxed),
            ),
        ];
        for (name, help, value) in gauges {
            out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} gauge\n"));
            out.push_str(&format!("{name} {value}\n"));
        }

        let counters = [
            (
                "http_request_body_bytes_total",
                "Request body bytes read.",
                self.request_bytes.load(Ordering::Relaxed),
            ),
            (
                "http_response_body_bytes_total",
                "Response body bytes written.",
                self.response_bytes.load(Ordering::Relaxed),
            ),
            (
                "http_cache_hits_total",
                "Native response cache hits (answered without waking JS).",
                self.cache_hits.load(Ordering::Relaxed),
            ),
            (
                "http_cache_misses_total",
                "Native response cache misses on cache-enabled routes.",
                self.cache_misses.load(Ordering::Relaxed),
            ),
        ];
        for (name, help, value) in counters {
            out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} counter\n"));
            out.push_str(&format!("{name} {value}\n"));
        }

        out
    }
}

fn method_index(method: &str) -> usize {
    METHODS
        .iter()
        .position(|m| *m == method)
        .unwrap_or(OTHER_METHOD)
}

fn class_index(status: u16) -> usize {
    match status / 100 {
        1 => 0,
        2 => 1,
        3 => 2,
        4 => 3,
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn counts_by_method_and_class() {
        let m = Metrics::new();
        m.request_started();
        m.request_finished("GET", 200, Duration::from_millis(3));
        m.request_started();
        m.request_finished("POST", 404, Duration::from_millis(30));
        m.request_started();
        m.request_finished("BREW", 500, Duration::from_millis(3));

        let out = m.encode();
        assert!(out.contains("http_requests_total{method=\"GET\",status=\"2xx\"} 1"));
        assert!(out.contains("http_requests_total{method=\"POST\",status=\"4xx\"} 1"));
        // An unknown method collapses into `other` to keep cardinality bounded.
        assert!(out.contains("http_requests_total{method=\"other\",status=\"5xx\"} 1"));
        assert!(out.contains("http_requests_in_flight 0"));
    }

    #[test]
    fn histogram_is_cumulative() {
        let m = Metrics::new();
        for _ in 0..3 {
            m.request_started();
            m.request_finished("GET", 200, Duration::from_millis(2));
        }
        let out = m.encode();
        // 2ms lands in the 0.005 bucket and every one above it.
        assert!(out.contains("http_request_duration_seconds_bucket{le=\"0.005\"} 3"));
        assert!(out.contains("http_request_duration_seconds_bucket{le=\"0.1\"} 3"));
        assert!(out.contains("http_request_duration_seconds_bucket{le=\"+Inf\"} 3"));
        assert!(out.contains("http_request_duration_seconds_count 3"));
        // 0.001 is below the measurement — nothing should land there.
        assert!(out.contains("http_request_duration_seconds_bucket{le=\"0.001\"} 0"));
    }
}
