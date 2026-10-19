import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { argument, JELLY_TABLES, sqlLiteral } from './jelly-dataset-config.js';

export function exportCsv(outputOverride?: string): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const output = path.resolve(outputOverride ?? argument('output') ?? 'exports/jelly-trail-academy');
  fs.mkdirSync(output, { recursive: true });
  for (const table of JELLY_TABLES) {
    const target = path.join(output, `${table}.csv`);
    execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', `\\copy jelly_analytics.${table} to '${sqlLiteral(target)}' with (format csv, header true)`], { stdio: 'inherit' });
  }
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify({ ok: true, output: exportCsv() }));
