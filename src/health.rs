//! Probes and readiness state (§11).
//!
//! `/healthz` — is the process alive (liveness): always answers while the runtime runs.
//! `/readyz` — is it ready to take traffic (readiness): turns off on shutdown, under
//! overload, and via a flag from JS (`app.setReady`, the periodic readinessCheck).
//!
//! Both probes are served entirely in Rust: k8s hits them once a second, and waking
//! a JS handler for that is pointless.

use std::sync::atomic::{AtomicBool, Ordering};

/// Probe and metrics paths. An empty string disables the endpoint.
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

/// Readiness state. Composed of three independent "not ready" reasons.
#[derive(Default)]
pub struct Readiness {
    /// Graceful shutdown in progress — leave the endpoints before the drain finishes.
    draining: AtomicBool,
    /// Flag from JS: `app.setReady(false)` or a failed readinessCheck.
    js_not_ready: AtomicBool,
    /// Sustained overload (set by the C5 layer).
    overloaded: AtomicBool,
}

impl Readiness {
    pub fn set_draining(&self, v: bool) {
        self.draining.store(v, Ordering::Relaxed);
    }
    pub fn set_js_ready(&self, ready: bool) {
        self.js_not_ready.store(!ready, Ordering::Relaxed);
    }
    /// Wired up by the overload layer (C5, M10b); the field already feeds `is_ready`.
    #[allow(dead_code)]
    pub fn set_overloaded(&self, v: bool) {
        self.overloaded.store(v, Ordering::Relaxed);
    }

    /// Whether the pod is ready to accept new traffic.
    pub fn is_ready(&self) -> bool {
        !self.draining.load(Ordering::Relaxed)
            && !self.js_not_ready.load(Ordering::Relaxed)
            && !self.overloaded.load(Ordering::Relaxed)
    }

    /// Refusal reason — goes into the `/readyz` body so `kubectl describe` stays readable.
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
        // Drain outranks the other reasons: the pod is already going away.
        assert_eq!(r.reason(), "draining");
    }
}
