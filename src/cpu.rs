//! Detecting the available CPU quota (§6c A3).
//!
//! Inside a container `available_parallelism()` returns the **node's** core count,
//! not the pod limit. With `limits.cpu: 1` on a 64-core node tokio would spin up 64
//! workers — needless context switches and memory for stacks. We read the cgroup
//! quota and take the minimum.

/// How many workers to spin up: `min(cores, ceil(cgroup quota))`, but at least 1.
/// No cgroup (macOS, bare metal, no limit set) → the core count.
pub fn worker_threads_auto() -> usize {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    match cgroup_cpu_quota() {
        Some(q) if q >= 1.0 => (q.ceil() as usize).min(cores).max(1),
        // Quota below one core (e.g. 500m) — a single worker is enough.
        Some(_) => 1,
        None => cores,
    }
}

/// CPU quota in "cores" from cgroup v2 or v1. `None` — no quota.
fn cgroup_cpu_quota() -> Option<f64> {
    cgroup_v2().or_else(cgroup_v1)
}

/// cgroup v2: `/sys/fs/cgroup/cpu.max` — `<quota|max> <period>`.
fn cgroup_v2() -> Option<f64> {
    let raw = std::fs::read_to_string("/sys/fs/cgroup/cpu.max").ok()?;
    let mut parts = raw.split_whitespace();
    let quota = parts.next()?;
    let period: f64 = parts.next()?.parse().ok()?;
    if quota == "max" || period <= 0.0 {
        return None; // no limit set
    }
    let quota: f64 = quota.parse().ok()?;
    if quota <= 0.0 {
        return None;
    }
    Some(quota / period)
}

/// cgroup v1: separate quota/period files; `-1` in quota = no limit.
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
        assert!(n <= cores, "workers must not exceed the core count");
    }
}
