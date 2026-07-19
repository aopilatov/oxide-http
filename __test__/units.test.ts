import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBytes, parseDuration } from '../js/units.ts';

test('M3: parseBytes string and number', () => {
  assert.equal(parseBytes('10mb'), 10 * 1024 * 1024);
  assert.equal(parseBytes('16kb'), 16 * 1024);
  assert.equal(parseBytes('1gb'), 1024 ** 3);
  assert.equal(parseBytes('512'), 512); // no unit = bytes
  assert.equal(parseBytes(2048), 2048); // number passed through
  assert.equal(parseBytes(undefined), undefined);
});

test('M3: parseDuration string and number', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('75s'), 75_000);
  assert.equal(parseDuration('1m'), 60_000);
  assert.equal(parseDuration('500'), 500); // no unit = ms
  assert.equal(parseDuration(250), 250);
});

test('M3: invalid values throw', () => {
  assert.throws(() => parseBytes('10xb'));
  assert.throws(() => parseDuration('abc'));
  assert.throws(() => parseBytes(-1));
});
