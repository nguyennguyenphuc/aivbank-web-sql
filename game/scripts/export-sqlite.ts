import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { argument, JELLY_TABLES } from './jelly-dataset-config.js';
import { exportCsv } from './export-csv.js';

function csvHeader(file: string): string[] {
  const header = fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0];
  return header.split(',').map(value => value.trim());
}

export function exportSqlite(targetOverride?: string): string {
  const target = path.resolve(targetOverride ?? argument('output') ?? 'exports/jelly-trail-academy.sqlite');
  if (fs.existsSync(target) && !process.argv.includes('--overwrite')) throw new Error(`${target} exists; pass --overwrite`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  const csvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jta-export-'));
  try {
    exportCsv(csvDir);
    const commands = ['PRAGMA journal_mode=WAL;', 'BEGIN;'];
    for (const table of JELLY_TABLES) {
      const file = path.join(csvDir, `${table}.csv`);
      const columns = csvHeader(file).map(column => `"${column}" TEXT`).join(', ');
      commands.push(`CREATE TABLE "${table}" (${columns});`, '.mode csv', `.import --skip 1 '${file.replaceAll("'", "''")}' "${table}"`);
    }
    commands.push('COMMIT;', 'VACUUM;');
    const result = spawnSync('sqlite3', [target], { input: `${commands.join('\n')}\n`, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'sqlite3 export failed');
    return target;
  } finally {
    fs.rmSync(csvDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify({ ok: true, output: exportSqlite() }));
