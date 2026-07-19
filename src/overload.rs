//! Overload protection (§6c C5).
//!
//! A limit on concurrently handled requests. Above the limit there is a short queue
//! (a burst waits for a slot), and beyond that `503 + Retry-After`. Under sustained
//! overload we additionally drop readiness: k8s removes the pod from the endpoints and
//! new connections go to other replicas.
//!
//! Why two layers: a plain Service (kube-proxy) cannot "hand the request to another
//! pod", so layer 1 (`503`) is always needed — behind a retry-capable ingress/mesh the
//! request moves over without the client seeing an error. Layer 2 (readiness) affects
//! only **new** connections, while an already open h2 connection keeps sending streams
//! to the same pod — which is why for h2 the `503` plus closing the connection
//! (`GOAWAY`) matters more.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{Semaphore, TryAcquireError};

/// Outcome of an attempt to take a slot.
pub enum Slot {
    /// Slot acquired; while the permit lives the request counts as in flight.
    Acquired(tokio::sync::OwnedSemaphorePermit),
    /// No room — respond `503` and ask to retry after `Retry-After` seconds.
    Rejected { retry_after: u64 },
}

/// Concurrent request limiter.
pub struct Limiter {
    sem: std::sync::Arc<Semaphore>,
    /// How many requests may wait for a slot beyond the limit. 0 = no queue.
    max_queue: usize,
    /// How long to wait in the queue before giving up.
    queue_timeout: Duration,
    /// Current queue depth (Semaphore does not expose the number of waiters).
    queued: AtomicU64,
    /// `Retry-After` value in seconds.
    retry_after: u64,
    /// How long continuous overload must last before readiness drops. None = never.
    shed_after: Option<Duration>,
    /// Start of the current overload streak, ms since `base`. 0 = no overload.
    saturated_since_ms: AtomicU64,
    base: Instant,
}

impl Limiter {
    pub fn new(
        max_concurrent: usize,
        max_queue: usize,
        queue_timeout: Duration,
        retry_after: u64,
        shed_after: Option<Duration>,
    ) -> Self {
        Limiter {
            sem: std::sync::Arc::new(Semaphore::new(max_concurrent)),
            max_queue,
            queue_timeout,
            queued: AtomicU64::new(0),
            retry_after,
            shed_after,
            saturated_since_ms: AtomicU64::new(0),
            base: Instant::now(),
        }
    }

    /// Take a slot: immediately, via the queue, or refuse.
    pub async fn acquire(&self) -> Slot {
        // Fast path: a slot is free — this also clears the overload streak.
        match self.sem.clone().try_acquire_owned() {
            Ok(permit) => {
                self.clear_saturation();
                return Slot::Acquired(permit);
            }
            Err(TryAcquireError::Closed) => {
                return Slot::Rejected {
                    retry_after: self.retry_after,
                }
            }
            Err(TryAcquireError::NoPermits) => {}
        }

        self.mark_saturated();

        if self.max_queue == 0 {
            return Slot::Rejected {
                retry_after: self.retry_after,
            };
        }

        // The queue is bounded: otherwise under load it grows into an unbounded buffer
        // and clients wait for a response nobody needs anymore.
        let depth = self.queued.fetch_add(1, Ordering::Relaxed);
        if depth as usize >= self.max_queue {
            self.queued.fetch_sub(1, Ordering::Relaxed);
            return Slot::Rejected {
                retry_after: self.retry_after,
            };
        }

        let waited =
            tokio::time::timeout(self.queue_timeout, self.sem.clone().acquire_owned()).await;
        self.queued.fetch_sub(1, Ordering::Relaxed);

        match waited {
            Ok(Ok(permit)) => Slot::Acquired(permit),
            _ => Slot::Rejected {
                retry_after: self.retry_after,
            },
        }
    }

    /// Whether overload has lasted long enough to drop readiness.
    pub fn should_shed(&self) -> bool {
        let Some(threshold) = self.shed_after else {
            return false;
        };
        let since = self.saturated_since_ms.load(Ordering::Relaxed);
        if since == 0 {
            return false;
        }
        let now = self.base.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(since)) >= threshold
    }

    /// Mark the start of an overload streak (if one is not running already).
    fn mark_saturated(&self) {
        let now = self.base.elapsed().as_millis() as u64;
        // Only the first refusal in a streak sets the origin; max(1) avoids confusing
        // "started at millisecond zero" with "no overload".
        let _ = self.saturated_since_ms.compare_exchange(
            0,
            now.max(1),
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }

    /// A slot was free right away — the overload is over.
    fn clear_saturation(&self) {
        self.saturated_since_ms.store(0, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn rejects_over_limit_without_queue() {
        let l = Limiter::new(1, 0, Duration::from_millis(50), 1, None);
        let first = l.acquire().await;
        assert!(matches!(first, Slot::Acquired(_)));
        // Slot taken, no queue → refuse immediately.
        assert!(matches!(l.acquire().await, Slot::Rejected { .. }));
        drop(first);
        assert!(matches!(l.acquire().await, Slot::Acquired(_)));
    }

    #[tokio::test]
    async fn queue_waits_for_slot() {
        let l = Arc::new(Limiter::new(1, 4, Duration::from_millis(500), 1, None));
        let held = l.acquire().await;

        let l2 = l.clone();
        let waiter = tokio::spawn(async move { l2.acquire().await });

        // Free the slot — the waiter should get it instead of a refusal.
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(held);
        assert!(matches!(waiter.await.unwrap(), Slot::Acquired(_)));
    }

    #[tokio::test]
    async fn queue_timeout_rejects() {
        let l = Limiter::new(1, 4, Duration::from_millis(60), 3, None);
        let _held = l.acquire().await;
        match l.acquire().await {
            Slot::Rejected { retry_after } => assert_eq!(retry_after, 3),
            Slot::Acquired(_) => panic!("expected refusal on queue timeout"),
        }
    }

    #[tokio::test]
    async fn shedding_turns_on_after_sustained_overload() {
        let l = Limiter::new(
            1,
            0,
            Duration::from_millis(10),
            1,
            Some(Duration::from_millis(120)),
        );
        let held = l.acquire().await;

        assert!(matches!(l.acquire().await, Slot::Rejected { .. }));
        assert!(!l.should_shed(), "an instant burst must not drop readiness");

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(matches!(l.acquire().await, Slot::Rejected { .. }));
        assert!(l.should_shed(), "sustained overload drops readiness");

        // A slot freed up — the overload streak has ended.
        drop(held);
        assert!(matches!(l.acquire().await, Slot::Acquired(_)));
        assert!(!l.should_shed());
    }
}
