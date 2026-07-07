#![deny(clippy::all)]

use napi_derive::napi;

/// Тривиальный экспорт для проверки моста napi-rs (DoD M0).
/// Будет удалён на M1, когда появится класс `Server`.
#[napi]
pub fn sum(a: i32, b: i32) -> i32 {
    a + b
}
