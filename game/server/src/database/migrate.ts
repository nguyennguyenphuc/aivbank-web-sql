import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { loadEnv } from '../config/env.js';
import { getMigrationsDir } from './sql-paths.js';

interface MigrationFile {
  version: string;
  up: string;
  down: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const dir = getMigrationsDir();
  const entries = await fs.readdir(dir);
  const versions = new Map<string, Partial<MigrationFile>>();

  for (const entry of entries) {
    const match = entry.match(/^(\d{4,})(?:[_-][a-z0-9_-]+)?\.(up|down)\.sql$/i);
    if (!match) continue;
    const [, version, direction] = match;
    const current = (versions.get(version) ?? { version }) as Partial<MigrationFile> & Record<string, string | undefined>;
    const filePath = path.join(dir, entry);
    const sql = await fs.readFile(filePath, 'utf8');
    current[direction] = sql;
    versions.set(version, current);
  }

  return Array.from(versions.values())
    .filter((item): item is MigrationFile => Boolean(item.version && item.up && item.down))
    .sort((a, b) => a.version.localeCompare(b.version));
}

async function ensureMigrationTable(client: Client): Promise<void> {
  await client.query(`
    create table if not exists app_schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    );
  `);
}

async function getAppliedVersions(client: Client): Promise<string[]> {
  const result = await client.query<{ version: string }>('select version from app_schema_migrations order by version asc');
  return result.rows.map(row => row.version);
}

async function migrateUp(client: Client, migrations: MigrationFile[]): Promise<void> {
  const applied = new Set(await getAppliedVersions(client));

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await client.query('begin');
    try {
      await client.query(migration.up);
      await client.query('insert into app_schema_migrations(version) values ($1)', [migration.version]);
      await client.query('commit');
      console.log(`applied ${migration.version}`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
}

async function migrateDown(client: Client, migrations: MigrationFile[]): Promise<void> {
  const applied = await getAppliedVersions(client);
  const version = applied.at(-1);
  if (!version) {
    console.log('no migrations to roll back');
    return;
  }

  const migration = migrations.find(item => item.version === version);
  if (!migration) {
    throw new Error(`missing migration files for version ${version}`);
  }

  await client.query('begin');
  try {
    await client.query(migration.down);
    await client.query('delete from app_schema_migrations where version = $1', [version]);
    await client.query('commit');
    console.log(`reverted ${version}`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down') {
    throw new Error('usage: tsx src/database/migrate.ts up|down');
  }

  const env = loadEnv();
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await ensureMigrationTable(client);
    const migrations = await loadMigrations();
    if (command === 'up') {
      await migrateUp(client, migrations);
    } else {
      await migrateDown(client, migrations);
    }
  } finally {
    await client.end();
  }
}

void main();
