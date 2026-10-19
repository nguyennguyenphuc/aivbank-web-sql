import 'dotenv/config';
import { scryptSync } from 'node:crypto';
import { Client } from 'pg';

const accounts = [
  { id: '01000000-0000-4000-8000-000000000001', email: 'instructor@jelly.local', role: 'instructor' },
  { id: '01000000-0000-4000-8000-000000000002', email: 'analyst@jelly.local', role: 'analyst' },
  { id: '01000000-0000-4000-8000-000000000003', email: 'admin@jelly.local', role: 'admin' },
  { id: '01000000-0000-4000-8000-000000000004', email: 'student@jelly.local', role: 'student' },
] as const;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo accounts are disabled in production');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const [index, account] of accounts.entries()) {
      const salt = `jta-demo-salt-${index + 1}`;
      const passwordHash = `${salt}:${scryptSync('AcademyDemo!2026', salt, 32).toString('hex')}`;
      await client.query(
        `insert into accounts (account_id, email, password_hash, display_name, is_guest, status, created_at, updated_at)
         values ($1, $2, $3, $4, false, 'active', now(), now())
         on conflict (account_id) do update set email = excluded.email, password_hash = excluded.password_hash,
         display_name = excluded.display_name, is_guest = false, status = 'active', updated_at = now()`,
        [account.id, account.email, passwordHash, `Jelly ${account.role}`],
      );
      await client.query(
        'insert into role_grants (grant_id, account_id, role) values (gen_random_uuid(), $1, $2) on conflict (account_id, role) do nothing',
        [account.id, account.role],
      );
      await client.query(
        'insert into player_profiles (account_id, display_name) values ($1, $2) on conflict (account_id) do update set display_name = excluded.display_name, updated_at = now()',
        [account.id, `Jelly ${account.role}`],
      );
    }
    console.log(JSON.stringify({ ok: true, accounts: accounts.map(account => ({ email: account.email, role: account.role })) }));
  } finally { await client.end(); }
}

void main();
