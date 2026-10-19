import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { JELLY_TABLES, resolveDatasetRoot, sqlLiteral, syntheticRows } from './jelly-dataset-config.js';

interface Manifest {
  dataset_version: string;
  synthetic: boolean;
  tables: Record<string, number>;
  sha256: Record<string, string>;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  // libpq does not expand a URI stored in PGDATABASE. Keep credentials out of argv.
  const connection = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(connection.protocol)) throw new Error('Expected a PostgreSQL DATABASE_URL');
  const pgEnv: NodeJS.ProcessEnv = { ...process.env, PGDATABASE: decodeURIComponent(connection.pathname.slice(1)) };
  if (connection.hostname) pgEnv.PGHOST = connection.hostname.replace(/^\[|\]$/g, '');
  if (connection.port) pgEnv.PGPORT = connection.port;
  if (connection.username) pgEnv.PGUSER = decodeURIComponent(connection.username);
  if (connection.password) pgEnv.PGPASSWORD = decodeURIComponent(connection.password);
  const parameters: Record<string, string> = {
    host: 'PGHOST', port: 'PGPORT', user: 'PGUSER', password: 'PGPASSWORD', dbname: 'PGDATABASE',
    sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY',
    connect_timeout: 'PGCONNECT_TIMEOUT', application_name: 'PGAPPNAME', options: 'PGOPTIONS',
  };
  for (const [key, value] of connection.searchParams) {
    if (!Object.hasOwn(parameters, key)) throw new Error(`Unsupported database connection option: ${key}`);
    pgEnv[parameters[key]] = value;
  }
  const root = resolveDatasetRoot();
  if (/[\r\n]/.test(root)) throw new Error('Dataset path must not contain line breaks');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.dataset_version !== '3.0' || manifest.synthetic !== true || !manifest.tables || !manifest.sha256) {
    throw new Error('Expected the v3.0 synthetic teaching manifest');
  }
  if (Object.keys(manifest.tables).length !== JELLY_TABLES.length) throw new Error('Expected exactly 13 teaching tables');
  const expectedFiles = [...JELLY_TABLES.map(table => `data/${table}.csv`), 'jelly_trail_academy_v3_game_da.sqlite'];
  for (const relative of expectedFiles) {
    const expected = manifest.sha256[relative];
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error(`Missing checksum: ${relative}`);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(root, relative))) hash.update(chunk);
    if (hash.digest('hex') !== expected) throw new Error(`Checksum mismatch: ${relative}`);
  }

  // psql owns one connection/transaction for all COPY commands, count checks, and metadata.
  const targets = JELLY_TABLES.map(table => `jelly_analytics.${table}`).join(', ');
  const sql = ["SET LOCAL lock_timeout = '10s';", `LOCK TABLE ${targets} IN ACCESS EXCLUSIVE MODE;`];
  if (process.argv.includes('--reset')) {
    // Live AIV Bank rows (server/src/modules/live-projection) survive a reset.
    for (const table of JELLY_TABLES) sql.push(`DELETE FROM jelly_analytics.${table} WHERE ${syntheticRows(table)};`);
  } else {
    for (const table of JELLY_TABLES) {
      sql.push(`DO $check$ BEGIN IF EXISTS (SELECT 1 FROM jelly_analytics.${table} WHERE ${syntheticRows(table)}) THEN RAISE EXCEPTION 'Teaching tables must be empty; use --reset only with a backup'; END IF; END $check$;`);
    }
  }
  for (const table of JELLY_TABLES) {
    const expected = manifest.tables[`${table}.csv`];
    if (!Number.isSafeInteger(expected) || expected < 0) throw new Error(`Invalid manifest count: ${table}`);
    const csv = path.join(root, 'data', `${table}.csv`);
    const fd = fs.openSync(csv, 'r');
    const header = Buffer.alloc(8192);
    let bytes: number;
    try { bytes = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    const newline = header.subarray(0, bytes).indexOf(10);
    if (newline < 0) throw new Error(`CSV header missing or too long: ${table}`);
    const columns = header.subarray(0, newline).toString('utf8').trim().split(',');
    if (columns.some(column => !/^[a-z][a-z0-9_]*$/.test(column)) || new Set(columns).size !== columns.length) {
      throw new Error(`Invalid CSV column list: ${table}`);
    }
    sql.push(`\\copy jelly_analytics.${table} (${columns.join(', ')}) FROM '${sqlLiteral(csv)}' WITH (FORMAT csv, HEADER true)`);
    sql.push(`DO $check$ BEGIN IF (SELECT count(*) FROM jelly_analytics.${table} WHERE ${syntheticRows(table)}) <> ${expected} THEN RAISE EXCEPTION 'Row count mismatch: ${table}'; END IF; END $check$;`);
  }
  sql.push(`INSERT INTO jelly_analytics.dataset_metadata (singleton, manifest, imported_at) VALUES (true, '${sqlLiteral(JSON.stringify(manifest))}'::jsonb, now()) ON CONFLICT (singleton) DO UPDATE SET manifest = EXCLUDED.manifest, imported_at = EXCLUDED.imported_at;`);
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '--file=-'], {
    env: pgEnv,
    input: `${sql.join('\n')}\n`,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Dataset import failed; transaction was not committed');
  console.log(JSON.stringify({ ok: true, version: manifest.dataset_version, source: root, counts: manifest.tables }));
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Dataset import failed');
  process.exitCode = 1;
});
