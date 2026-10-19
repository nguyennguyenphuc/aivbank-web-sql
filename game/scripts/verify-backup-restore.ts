import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { syntheticRows } from './jelly-dataset-config.js';

async function main(): Promise<void> {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error('DATABASE_URL is required');
  const source = new URL(sourceUrl);
  const databaseName = `match3_h5_restore_verify_${Date.now()}`;
  const adminUrl = new URL(sourceUrl); adminUrl.pathname = '/postgres';
  const targetUrl = new URL(sourceUrl); targetUrl.pathname = `/${databaseName}`;
  const dump = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jta-backup-')), 'backup.dump');
  let created = false;
  try {
    execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', dump, sourceUrl], { stdio: 'inherit' });
    execFileSync('createdb', ['--maintenance-db', adminUrl.toString(), databaseName], { stdio: 'inherit' });
    created = true;
    execFileSync('pg_restore', ['--no-owner', '--no-privileges', '--dbname', targetUrl.toString(), dump], { stdio: 'inherit' });
    const client = new Client({ connectionString: targetUrl.toString() });
    await client.connect();
    try {
      const migrations = Number((await client.query('select count(*) count from app_schema_migrations')).rows[0].count);
      const compatibilityRows = Number((await client.query(`select count(*) count from jelly_analytics.level_attempts where ${syntheticRows('level_attempts')}`)).rows[0].count);
      if (migrations < 10 || compatibilityRows !== 249777) throw new Error(`Restore mismatch: migrations=${migrations} level_attempts=${compatibilityRows}`);
      console.log(JSON.stringify({ ok: true, migrations, compatibilityRows }));
    } finally { await client.end(); }
  } finally {
    if (created) execFileSync('dropdb', ['--maintenance-db', adminUrl.toString(), databaseName], { stdio: 'inherit' });
    fs.rmSync(path.dirname(dump), { recursive: true, force: true });
  }
}

void main();
