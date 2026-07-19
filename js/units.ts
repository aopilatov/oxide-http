// Config unit parser (§16): accepts both a string and a number.
// Sizes → bytes, durations → milliseconds. A number is taken as an already-final
// value (bytes/ms respectively).

/** A size value: `'10mb'` or a byte count. */
export type ByteSize = string | number;
/** A duration value: `'30s'` or a millisecond count. */
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
      throw new TypeError(`${kind}: invalid number ${value}`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${kind}: expected a string or number, got ${typeof value}`);
  }
  const m = value.trim().toLowerCase().match(/^([\d.]+)\s*([a-z]*)$/);
  // Under noUncheckedIndexedAccess the regex groups may be undefined even though the
  // pattern guarantees both are present.
  if (!m || m[1] === undefined) throw new TypeError(`${kind}: cannot parse "${value}"`);
  const num = parseFloat(m[1]);
  const unit = m[2] || (kind === 'bytes' ? 'b' : 'ms');
  const mult = table[unit];
  if (mult == null) throw new TypeError(`${kind}: unknown unit "${unit}" in "${value}"`);
  return Math.round(num * mult);
}

// Overloads: a definitely non-empty input returns an exact `number`. Without them
// every assignment into optional native-option fields would trip over
// `exactOptionalPropertyTypes`.

/** `'10mb'` | `10485760` → byte count. */
export function parseBytes(v: ByteSize): number;
export function parseBytes(v: ByteSize | null | undefined): number | undefined;
export function parseBytes(v: ByteSize | null | undefined): number | undefined {
  return parseUnit(v, SIZE, 'bytes');
}

/** `'30s'` | `30000` → millisecond count. */
export function parseDuration(v: Duration): number;
export function parseDuration(v: Duration | null | undefined): number | undefined;
export function parseDuration(v: Duration | null | undefined): number | undefined {
  return parseUnit(v, TIME, 'duration');
}
