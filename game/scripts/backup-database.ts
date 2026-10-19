import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { argument } from './jelly-dataset-config.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const output = path.resolve(argument('output') ?? `backups/match3-h5-${new Date().toISOString().replaceAll(':', '-')}.dump`);
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', output, databaseUrl], { stdio: 'inherit' });
console.log(JSON.stringify({ ok: true, output, bytes: fs.statSync(output).size }));
