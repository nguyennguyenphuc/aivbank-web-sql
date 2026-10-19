export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const fail = (error: string): ParseResult<never> => ({ ok: false, error });
export function coerceParseResult<T>(result: ParseResult<unknown>): ParseResult<T> {
  if (result.ok) return ok(result.value as T);
  return fail((result as { ok: false; error: string }).error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function asTrimmedString(value: unknown, name = 'value'): ParseResult<string> {
  return isString(value) ? ok(value.trim()) : fail(`Expected string for ${name}`);
}

export function asNonEmptyString(value: unknown, name = 'value'): ParseResult<string> {
  if (!isString(value)) return fail('Expected string');
  const trimmed = value.trim();
  return trimmed.length > 0 ? ok(trimmed) : fail(`Expected non-empty string for ${name}`);
}

export function asInteger(
  value: unknown,
  name = 'value',
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): ParseResult<number> {
  if (!isInteger(value)) return fail(`Expected integer for ${name}`);
  if (value < min || value > max) return fail(`Out of range for ${name}`);
  return ok(value);
}

export function asBooleanValue(value: unknown): ParseResult<boolean> {
  return isBoolean(value) ? ok(value) : fail('Expected boolean');
}

export function asEnumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name = 'value',
): ParseResult<T[number]> {
  if (!isString(value)) return fail(`Expected string for ${name}`);
  return (allowed as readonly string[]).includes(value)
    ? ok(value as T[number])
    : fail(`Invalid ${name}`);
}

export function asStringArray(value: unknown, name = 'value'): ParseResult<string[]> {
  if (!Array.isArray(value)) return fail(`Expected array for ${name}`);
  if (value.some(item => !isString(item))) return fail(`Expected string array for ${name}`);
  return ok(value.map(item => item.trim()).filter(Boolean));
}

export function asRecord(value: unknown, name = 'value'): ParseResult<Record<string, unknown>> {
  return isRecord(value) ? ok(value) : fail(`Expected object for ${name}`);
}

export function asOptionalRecord(
  value: unknown,
  name = 'value',
): ParseResult<Record<string, unknown> | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  return asRecord(value, name);
}

export function pickValue<T>(
  source: Record<string, unknown>,
  key: string,
  parser: (value: unknown) => ParseResult<T>,
): ParseResult<T> {
  return parser(source[key]);
}

export function pickOptionalValue<T>(
  source: Record<string, unknown>,
  key: string,
  parser: (value: unknown) => ParseResult<T>,
): ParseResult<T | undefined> {
  const value = source[key];
  if (value === undefined || value === null) return ok(undefined);
  const parsed = parser(value);
  return parsed.ok ? ok(parsed.value) : parsed;
}

export function parseDateTimeString(value: unknown, name = 'value'): ParseResult<string> {
  if (!isString(value)) return fail(`Expected datetime string for ${name}`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? ok(trimmed) : fail(`Expected datetime string for ${name}`);
}
