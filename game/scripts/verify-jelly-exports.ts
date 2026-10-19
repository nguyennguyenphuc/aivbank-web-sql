import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { exportCsv } from './export-csv.js';
import { exportSqlite } from './export-sqlite.js';
import { JELLY_TABLES, resolveDatasetRoot } from './jelly-dataset-config.js';

interface Manifest { tables: Record<string, number> }

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const manifest = JSON.parse(fs.readFileSync(path.join(resolveDatasetRoot(), 'manifest.json'), 'utf8')) as Manifest;
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'jta-verify-'));
  const csvDir = path.join(output, 'csv');
  const sqlite = path.join(output, 'jelly.sqlite');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    exportCsv(csvDir);
    process.argv.push('--overwrite');
    exportSqlite(sqlite);
    const counts: Record<string, number> = {};
    for (const table of JELLY_TABLES) {
      const pg = Number((await client.query<{ count: string }>(`select count(*) count from jelly_analytics.${table}`)).rows[0].count);
      const sqliteCount = Number(execFileSync('sqlite3', [sqlite, `select count(*) from "${table}"`], { encoding: 'utf8' }).trim());
      const csvRows = Math.max(0, fs.readFileSync(path.join(csvDir, `${table}.csv`), 'utf8').split(/\r?\n/).filter(Boolean).length - 1);
      const expected = manifest.tables[`${table}.csv`];
      if (pg !== expected || sqliteCount !== expected || csvRows !== expected) {
        throw new Error(`${table}: source=${expected} pg=${pg} sqlite=${sqliteCount} csv=${csvRows}`);
      }
      counts[table] = expected;
    }
    const signalResult = await client.query<{ app_version: string; completion_rate: string }>(
      `select app_version, completion_rate::text from jelly_analytics.tutorial_step4_health
       where platform = 'Android' and region = 'SEA' order by app_version`,
    );
    const signals = signalResult.rows;
    if (!signals.some(row => row.app_version === '2.1.0')) throw new Error('Teaching regression segment is missing');
    console.log(JSON.stringify({ ok: true, counts, tutorialSignals: signals }));
  } finally {
    await client.end();
    fs.rmSync(output, { recursive: true, force: true });
  }
}

void main();
