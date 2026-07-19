import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBytes, parseDuration } from '../js/units.ts';

test('M3: parseBytes строка и число', () => {
  assert.equal(parseBytes('10mb'), 10 * 1024 * 1024);
  assert.equal(parseBytes('16kb'), 16 * 1024);
  assert.equal(parseBytes('1gb'), 1024 ** 3);
  assert.equal(parseBytes('512'), 512); // без единицы = байты
  assert.equal(parseBytes(2048), 2048); // число как есть
  assert.equal(parseBytes(undefined), undefined);
});

test('M3: parseDuration строка и число', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('75s'), 75_000);
  assert.equal(parseDuration('1m'), 60_000);
  assert.equal(parseDuration('500'), 500); // без единицы = мс
  assert.equal(parseDuration(250), 250);
});

test('M3: неверные значения бросают', () => {
  assert.throws(() => parseBytes('10xb'));
  assert.throws(() => parseDuration('abc'));
  assert.throws(() => parseBytes(-1));
});
