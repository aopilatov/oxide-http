//! Защита от перегрузки (§6c C5).
//!
//! Лимит одновременно обрабатываемых запросов. Сверх лимита — короткая очередь
//! (всплеск подождёт слот), а дальше `503 + Retry-After`. При устойчивой перегрузке
//! дополнительно снимаем readiness: k8s уберёт под из эндпоинтов, и новые соединения
//! пойдут на другие реплики.
//!
//! Зачем два слоя: обычный Service (kube-proxy) не умеет «отдать запрос другому поду»,
//! поэтому слой 1 (`503`) нужен всегда — за retry-способным ingress/mesh запрос
//! переедет без ошибки у клиента. Слой 2 (readiness) действует только на **новые**
//! соединения, а уже открытое h2-соединение продолжит слать стримы на тот же под —
//! поэтому для h2 важнее `503` + закрытие соединения (`GOAWAY`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::{Semaphore, TryAcquireError};

/// Исход попытки занять слот.
pub enum Slot {
    /// Слот получен; пока permit жив, запрос считается «в обработке».
    Acquired(tokio::sync::OwnedSemaphorePermit),
    /// Мест нет — отдаём `503` и просим повторить через `Retry-After` секунд.
    Rejected { retry_after: u64 },
}

/// Ограничитель одновременных запросов.
pub struct Limiter {
    sem: std::sync::Arc<Semaphore>,
    /// Сколько запросов может ждать слот сверх лимита. 0 = очереди нет.
    max_queue: usize,
    /// Сколько ждать в очереди, прежде чем сдаться.
    queue_timeout: Duration,
    /// Текущая длина очереди (Semaphore не отдаёт число ожидающих).
    queued: AtomicU64,
    /// Значение `Retry-After` в секундах.
    retry_after: u64,
    /// Насколько долгая непрерывная перегрузка снимает readiness. None = не снимать.
    shed_after: Option<Duration>,
    /// Начало текущей полосы перегрузки, мс от `base`. 0 = перегрузки нет.
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

    /// Занять слот: сразу, через очередь либо отказ.
    pub async fn acquire(&self) -> Slot {
        // Быстрый путь: слот свободен — заодно сбрасываем полосу перегрузки.
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

        // Очередь ограничена: иначе под перегрузкой она вырастет в неограниченный
        // буфер, и клиенты будут ждать ответа, который уже никому не нужен.
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

    /// Держится ли перегрузка достаточно долго, чтобы снимать readiness.
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

    /// Отметить начало полосы перегрузки (если она ещё не идёт).
    fn mark_saturated(&self) {
        let now = self.base.elapsed().as_millis() as u64;
        // Только первый отказ в полосе задаёт точку отсчёта; max(1) — чтобы
        // не спутать «началось на нулевой миллисекунде» с «перегрузки нет».
        let _ = self.saturated_since_ms.compare_exchange(
            0,
            now.max(1),
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }

    /// Слот нашёлся сразу — перегрузка кончилась.
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
        // Слот занят, очереди нет → отказ сразу.
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

        // Освобождаем слот — ожидающий должен его получить, а не получить отказ.
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
            Slot::Acquired(_) => panic!("ожидался отказ по таймауту очереди"),
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
        assert!(
            !l.should_shed(),
            "мгновенный всплеск не должен снимать readiness"
        );

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(matches!(l.acquire().await, Slot::Rejected { .. }));
        assert!(l.should_shed(), "устойчивая перегрузка снимает readiness");

        // Освободился слот — полоса перегрузки закончилась.
        drop(held);
        assert!(matches!(l.acquire().await, Slot::Acquired(_)));
        assert!(!l.should_shed());
    }
}
