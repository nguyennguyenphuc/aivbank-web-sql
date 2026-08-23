/* Value formatting for the result grid.
 *
 * Follows the "JSON value encoding" table in API_CONTRACT.md §7. The two rules
 * that matter most for this dataset:
 *
 *   1. Money is INTEGER VND (BIGINT). It must be readable but must NEVER be
 *      rounded, abbreviated ("1.2 tỷ"), or scaled. Grouping is applied purely
 *      as text; the exact value stays available via the cell tooltip and is the
 *      only thing the CSV export writes.
 *   2. DECIMAL arrives as a STRING to preserve exactness. It is grouped as text
 *      and never passed through Number().
 */

import { isExact } from './api.js';

const NUMERIC_TYPE_RE = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/i;

export function isNumericType(duckType) {
  return NUMERIC_TYPE_RE.test(String(duckType || ''));
}

/** Group the integer part of an already-exact numeric STRING. Never parses to float. */
export function groupNumericText(s) {
  const str = String(s);
  if (!/^-?\d+(\.\d+)?$/.test(str)) return str; // scientific notation, Inf, etc: leave alone
  const neg = str.startsWith('-');
  const body = neg ? str.slice(1) : str;
  const [intPart, fracPart] = body.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (fracPart !== undefined ? '.' + fracPart : '');
}

/**
 * Turn one raw JSON cell value into what the grid should show.
 * Returns { text, exact, cls, warn } where `exact` is the unrounded value used
 * for tooltips and CSV export.
 */
export function formatCell(value, duckType, { group = true } = {}) {
  if (value === null || value === undefined) {
    // Covers SQL NULL and, per the contract, DOUBLE NaN / Infinity which the
    // backend encodes as null.
    return { text: 'NULL', exact: '', cls: 'v-null', warn: false };
  }

  if (isExact(value)) {
    // Integer too large for a JS number; digits preserved by api.js.
    const digits = value.__exactDigits;
    return {
      text: group ? groupNumericText(digits) : digits,
      exact: digits,
      cls: 'v-num',
      warn: false,
    };
  }

  if (typeof value === 'boolean') {
    return { text: value ? 'true' : 'false', exact: String(value), cls: 'v-bool', warn: false };
  }

  if (typeof value === 'number') {
    const raw = String(value);
    // Only reachable if the runtime lacks the exact-JSON reviver: flag rather
    // than silently display a number whose last digits may be wrong.
    const warn = Number.isInteger(value) && !Number.isSafeInteger(value);
    return { text: group ? groupNumericText(raw) : raw, exact: raw, cls: 'v-num', warn };
  }

  if (typeof value === 'string') {
    // DECIMAL is delivered as a string precisely so it stays exact.
    if (isNumericType(duckType) && /^-?\d+(\.\d+)?$/.test(value)) {
      return {
        text: group ? groupNumericText(value) : value,
        exact: value,
        cls: 'v-num',
        warn: false,
      };
    }
    return { text: value, exact: value, cls: cssForStringType(duckType), warn: false };
  }

  // LIST / STRUCT / MAP arrive as real JSON arrays / objects.
  const json = jsonStringifyExact(value);
  return { text: json, exact: json, cls: 'v-json', warn: false };
}

function cssForStringType(duckType) {
  const t = String(duckType || '').toUpperCase();
  if (t.startsWith('DATE') || t.startsWith('TIMESTAMP') || t.startsWith('TIME')) return 'v-temporal';
  if (t.startsWith('INTERVAL')) return 'v-temporal';
  if (t.startsWith('BLOB')) return 'v-blob';
  return 'v-str';
}

/** JSON.stringify for LIST/STRUCT/MAP values, emitting big integers as bare digits. */
export function jsonStringifyExact(value) {
  if (value === null || value === undefined) return 'null';
  if (isExact(value)) return value.__exactDigits;
  if (Array.isArray(value)) return '[' + value.map(jsonStringifyExact).join(', ') + ']';
  if (typeof value === 'object') {
    const parts = Object.keys(value).map(
      (k) => JSON.stringify(k) + ': ' + jsonStringifyExact(value[k])
    );
    return '{' + parts.join(', ') + '}';
  }
  return JSON.stringify(value);
}

/** Shorten the DuckDB type shown in the column header, keeping it recognisable. */
export function shortType(duckType) {
  const t = String(duckType || '');
  return t.length > 24 ? t.slice(0, 21) + '…' : t;
}

/** RFC4180-ish CSV, always from the EXACT values (never the grouped display text). */
export function toCsv(columns, rows, columnTypes) {
  const esc = (s) => {
    const v = String(s);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const out = [columns.map(esc).join(',')];
  for (const row of rows) {
    out.push(
      row
        .map((cell, i) => {
          const f = formatCell(cell, columnTypes[i], { group: false });
          return f.cls === 'v-null' ? '' : esc(f.exact);
        })
        .join(',')
    );
  }
  return out.join('\r\n');
}
