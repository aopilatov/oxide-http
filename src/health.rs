//! Пробы и состояние готовности (§11).
//!
//! `/healthz` — жив ли процесс (liveness): отвечает всегда, пока рантайм крутится.
//! `/readyz` — готов ли принимать трафик (readiness): выключается на shutdown,
//! при перегрузке и по флагу из JS (`app.setReady`, периодический readinessCheck).
//!
//! Обе пробы обслуживаются целиком в Rust: k8s дёргает их раз в секунду, будить
//! ради этого JS-хендлер незачем.

use std::sync::atomic::{AtomicBool, Ordering};

/// Пути проб и метрик. Пустая строка = ручка выключена.
pub struct HealthPaths {
    pub health: String,
    pub ready: String,
    pub metrics: String,
}

impl Default for HealthPaths {
    fn default() -> Self {
        HealthPaths {
            health: "/healthz".to_string(),
            ready: "/readyz".to_string(),
            metrics: "/metrics".to_string(),
        }
    }
}

/// Состояние готовности. Складывается из трёх независимых причин «не готов».
#[derive(Default)]
pub struct Readiness {
    /// Идёт graceful shutdown — снимаемся с эндпоинтов до окончания drain'а.
    draining: AtomicBool,
    /// Флаг из JS: `app.setReady(false)` либо провалившийся readinessCheck.
    js_not_ready: AtomicBool,
    /// Устойчивая перегрузка (выставляется слоем C5; пока всегда false).
    overloaded: AtomicBool,
}

impl Readiness {
    pub fn set_draining(&self, v: bool) {
        self.draining.store(v, Ordering::Relaxed);
    }
    pub fn set_js_ready(&self, ready: bool) {
        self.js_not_ready.store(!ready, Ordering::Relaxed);
    }
    /// Подключается слоем перегрузки (C5, M10b); поле уже участвует в `is_ready`.
    #[allow(dead_code)]
    pub fn set_overloaded(&self, v: bool) {
        self.overloaded.store(v, Ordering::Relaxed);
    }

    /// Готов ли под принимать новый трафик.
    pub fn is_ready(&self) -> bool {
        !self.draining.load(Ordering::Relaxed)
            && !self.js_not_ready.load(Ordering::Relaxed)
            && !self.overloaded.load(Ordering::Relaxed)
    }

    /// Причина отказа — уходит в тело `/readyz`, чтобы `kubectl describe` был читаемым.
    pub fn reason(&self) -> &'static str {
        if self.draining.load(Ordering::Relaxed) {
            "draining"
        } else if self.overloaded.load(Ordering::Relaxed) {
            "overloaded"
        } else if self.js_not_ready.load(Ordering::Relaxed) {
            "not-ready"
        } else {
            "ready"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_reason_makes_not_ready() {
        let r = Readiness::default();
        assert!(r.is_ready());
        assert_eq!(r.reason(), "ready");

        r.set_js_ready(false);
        assert!(!r.is_ready());
        assert_eq!(r.reason(), "not-ready");

        r.set_js_ready(true);
        r.set_draining(true);
        assert!(!r.is_ready());
        // Drain важнее прочих причин: под уже уходит.
        assert_eq!(r.reason(), "draining");
    }
}
