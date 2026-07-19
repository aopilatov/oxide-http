//! Метрики в формате Prometheus (§11).
//!
//! Всё на атомиках без блокировок: счётчики живут в массивах фиксированного размера
//! (метод × класс статуса), гистограмма — массив бакетов + сумма + количество.
//! Ни аллокаций, ни `Mutex` на горячем пути запроса.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

/// Методы, для которых держим отдельные счётчики; всё остальное — `other`.
const METHODS: [&str; 8] = [
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "other",
];
const OTHER_METHOD: usize = 7;

/// Классы статуса: 1xx..5xx.
const CLASSES: [&str; 5] = ["1xx", "2xx", "3xx", "4xx", "5xx"];

/// Границы бакетов гистограммы латентности, секунды (аналог дефолта Prometheus).
const BUCKETS: [f64; 12] = [
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// Реестр метрик процесса. Один на сервер, шарится через `Arc<Shared>`.
pub struct Metrics {
    /// Запросы: [метод][класс статуса].
    requests: [[AtomicU64; CLASSES.len()]; METHODS.len()],
    /// Гистограмма латентности: кумулятивные счётчики по бакетам + сумма + всего.
    duration_buckets: [AtomicU64; BUCKETS.len()],
    duration_sum_micros: AtomicU64,
    duration_count: AtomicU64,
    /// Запросы в обработке прямо сейчас.
    in_flight: AtomicI64,
    /// Открытые соединения.
    connections: AtomicI64,
    /// Прочитанные/записанные байты тел.
    request_bytes: AtomicU64,
    response_bytes: AtomicU64,
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

    /// Запрос завершён: снять in-flight, разложить по счётчикам и гистограмме.
    pub fn request_finished(&self, method: &str, status: u16, elapsed: std::time::Duration) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);

        let m = method_index(method);
        let c = class_index(status);
        self.requests[m][c].fetch_add(1, Ordering::Relaxed);

        let secs = elapsed.as_secs_f64();
        for (i, edge) in BUCKETS.iter().enumerate() {
            if secs <= *edge {
                // Кумулятивность («le») достраивается при выводе, здесь — первый подходящий.
                self.duration_buckets[i].fetch_add(1, Ordering::Relaxed);
                break;
            }
        }
        self.duration_sum_micros
            .fetch_add(elapsed.as_micros() as u64, Ordering::Relaxed);
        self.duration_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Текстовый формат Prometheus (exposition format 0.0.4).
    pub fn encode(&self) -> String {
        let mut out = String::with_capacity(2048);

        out.push_str("# HELP http_requests_total Обработано HTTP-запросов.\n");
        out.push_str("# TYPE http_requests_total counter\n");
        for (mi, method) in METHODS.iter().enumerate() {
            for (ci, class) in CLASSES.iter().enumerate() {
                let v = self.requests[mi][ci].load(Ordering::Relaxed);
                if v == 0 {
                    continue; // не засоряем вывод нулями
                }
                out.push_str(&format!(
                    "http_requests_total{{method=\"{method}\",status=\"{class}\"}} {v}\n"
                ));
            }
        }

        out.push_str("# HELP http_request_duration_seconds Латентность обработки запроса.\n");
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
                "Запросы в обработке прямо сейчас.",
                self.in_flight.load(Ordering::Relaxed),
            ),
            (
                "http_connections_active",
                "Открытые соединения.",
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
                "Прочитано байт тел запросов.",
                self.request_bytes.load(Ordering::Relaxed),
            ),
            (
                "http_response_body_bytes_total",
                "Записано байт тел ответов.",
                self.response_bytes.load(Ordering::Relaxed),
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
        // Неизвестный метод схлопывается в other, чтобы не рос кардиналитет.
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
        // 2мс попадает в бакет 0.005 и во все следующие.
        assert!(out.contains("http_request_duration_seconds_bucket{le=\"0.005\"} 3"));
        assert!(out.contains("http_request_duration_seconds_bucket{le=\"0.1\"} 3"));
        assert!(out.contains("http_request_duration_seconds_bucket{le=\"+Inf\"} 3"));
        assert!(out.contains("http_request_duration_seconds_count 3"));
        // 0.001 меньше замера — туда не должно попасть.
        assert!(out.contains("http_request_duration_seconds_bucket{le=\"0.001\"} 0"));
    }
}
