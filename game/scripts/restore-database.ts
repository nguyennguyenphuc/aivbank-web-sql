import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { argument } from './jelly-dataset-config.js';

async function main(): Promise<void> {
  const input = argument('input');
  const targetUrl = argument('target-url');
  const confirmation = argument('confirm-target');
  if (!input || !fs.existsSync(input)) throw new Error('--input must reference an existing dump');
  if (!targetUrl) throw new Error('--target-url is required');
  const databaseName = new URL(targetUrl).pathname.slice(1);
  if (!databaseName || confirmation !== databaseName) throw new Error(`Pass --confirm-target ${databaseName} to restore`);
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const tables = await client.query("select count(*)::int count from pg_tables where schemaname not in ('pg_catalog','information_schema')");
    if (tables.rows[0].count > 0) throw new Error('Restore target must be an empty database');
  } finally { await client.end(); }
  execFileSync('pg_restore', ['--no-owner', '--no-privileges', '--dbname', targetUrl, input], { stdio: 'inherit' });
  console.log(JSON.stringify({ ok: true, target: databaseName }));
}

void main();
