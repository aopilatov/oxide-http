// Парсер единиц конфига (§16): принимаем и строку, и число.
// Размеры → байты, длительности → миллисекунды. Число трактуется как уже
// готовое значение (байты/мс соответственно).

/** Значение размера: `'10mb'` либо число байт. */
export type ByteSize = string | number;
/** Значение длительности: `'30s'` либо число миллисекунд. */
export type Duration = string | number;

const SIZE = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 } as const;
const TIME = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

type UnitTable = Record<string, number>;

function parseUnit(
  value: string | number | null | undefined,
  table: UnitTable,
  kind: 'bytes' | 'duration',
): number | undefined {
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
  // Группы регулярки при noUncheckedIndexedAccess — возможно undefined,
  // хотя по строению шаблона обе всегда есть.
  if (!m || m[1] === undefined) throw new TypeError(`${kind}: не разобрать «${value}»`);
  const num = parseFloat(m[1]);
  const unit = m[2] || (kind === 'bytes' ? 'b' : 'ms');
  const mult = table[unit];
  if (mult == null) throw new TypeError(`${kind}: неизвестная единица «${unit}» в «${value}»`);
  return Math.round(num * mult);
}

// Перегрузки: для заведомо непустого входа возвращается точный `number`.
// Без этого каждое присваивание в опциональные поля нативных опций спотыкалось
// бы об `exactOptionalPropertyTypes`.

/** `'10mb'` | `10485760` → число байт. */
export function parseBytes(v: ByteSize): number;
export function parseBytes(v: ByteSize | null | undefined): number | undefined;
export function parseBytes(v: ByteSize | null | undefined): number | undefined {
  return parseUnit(v, SIZE, 'bytes');
}

/** `'30s'` | `30000` → число миллисекунд. */
export function parseDuration(v: Duration): number;
export function parseDuration(v: Duration | null | undefined): number | undefined;
export function parseDuration(v: Duration | null | undefined): number | undefined {
  return parseUnit(v, TIME, 'duration');
}
