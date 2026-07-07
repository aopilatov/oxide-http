import test from 'node:test';
import assert from 'node:assert/strict';

import { sum } from '../index.js';

// Smoke-тест DoD M0: тривиальный экспорт из Rust вызывается из Node.
test('sum(a, b) вызывается через мост napi-rs', () => {
  assert.equal(sum(40, 2), 42);
  assert.equal(sum(-1, 1), 0);
});
