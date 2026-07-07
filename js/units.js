'use strict';

// Парсер единиц конфига (§16): принимаем и строку, и число.
// Размеры → байты, длительности → миллисекунды. Число трактуется как уже
// готовое значение (байты/мс соответственно).

const SIZE = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
const TIME = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseUnit(value, table, kind) {
  if (value == null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`${kind}: неверное число ${value}`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${kind}: ожидалась строка или число, получено ${typeof value}`);
  }
  const m = value.trim().toLowerCase().match(/^([\d.]+)\s*([a-z]*)$/);
  if (!m) throw new TypeError(`${kind}: не разобрать «${value}»`);
  const num = parseFloat(m[1]);
  const unit = m[2] || (kind === 'bytes' ? 'b' : 'ms');
  const mult = table[unit];
  if (mult == null) throw new TypeError(`${kind}: неизвестная единица «${unit}» в «${value}»`);
  return Math.round(num * mult);
}

/** '10mb' | 10485760 → число байт. */
const parseBytes = (v) => parseUnit(v, SIZE, 'bytes');

/** '30s' | 30000 → число миллисекунд. */
const parseDuration = (v) => parseUnit(v, TIME, 'duration');

module.exports = { parseBytes, parseDuration };
