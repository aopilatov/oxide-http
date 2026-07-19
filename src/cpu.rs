//! Определение доступной CPU-квоты (§6c A3).
//!
//! В контейнере `available_parallelism()` возвращает число ядер **ноды**, а не лимит
//! пода. При `limits.cpu: 1` на 64-ядерной ноде tokio поднял бы 64 воркера — лишние
//! переключения контекста и память на стеки. Читаем cgroup-квоту и берём минимум.

/// Сколько воркеров поднимать: `min(ядра, ceil(cgroup-квота))`, но не меньше 1.
/// Нет cgroup (macOS, голое железо, лимит не задан) → число ядер.
pub fn worker_threads_auto() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    match cgroup_cpu_quota() {
        Some(q) if q >= 1.0 => (q.ceil() as usize).min(cores).max(1),
        // Квота меньше ядра (например 500m) — одного воркера достаточно.
        Some(_) => 1,
        None => cores,
    }
}

/// CPU-квота в «ядрах» из cgroup v2 или v1. `None` — квоты нет.
fn cgroup_cpu_quota() -> Option<f64> {
    cgroup_v2().or_else(cgroup_v1)
}

/// cgroup v2: `/sys/fs/cgroup/cpu.max` — «`<quota|max> <period>`».
fn cgroup_v2() -> Option<f64> {
    let raw = std::fs::read_to_string("/sys/fs/cgroup/cpu.max").ok()?;
    let mut parts = raw.split_whitespace();
    let quota = parts.next()?;
    let period: f64 = parts.next()?.parse().ok()?;
    if quota == "max" || period <= 0.0 {
        return None; // лимит не задан
    }
    let quota: f64 = quota.parse().ok()?;
    if quota <= 0.0 {
        return None;
    }
    Some(quota / period)
}

/// cgroup v1: отдельные файлы quota/period; `-1` в квоте = без лимита.
fn cgroup_v1() -> Option<f64> {
    let quota: f64 = std::fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let period: f64 = std::fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    if quota <= 0.0 || period <= 0.0 {
        return None;
    }
    Some(quota / period)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_is_sane_on_this_machine() {
        let n = worker_threads_auto();
        assert!(n >= 1);
        let cores = std::thread::available_parallelism()
            .map(|x| x.get())
            .unwrap_or(1);
        assert!(n <= cores, "воркеров не должно быть больше ядер");
    }
}
