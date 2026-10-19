alter table accounts add column if not exists password_hash text;
alter table accounts add column if not exists is_guest boolean not null default true;
alter table auth_sessions add column if not exists rotation integer not null default 0;
alter table wallets add column if not exists revision integer not null default 0;

create table if not exists role_grants (
  grant_id uuid primary key,
  account_id uuid not null references accounts(account_id) on delete cascade,
  role text not null check (role in ('student', 'instructor', 'analyst', 'admin')),
  created_at timestamptz not null default now(),
  unique (account_id, role)
);

create table if not exists player_profiles (
  account_id uuid primary key references accounts(account_id) on delete cascade,
  display_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists player_settings (
  account_id uuid primary key references accounts(account_id) on delete cascade,
  sound boolean not null default true,
  music boolean not null default true,
  reduced_motion boolean not null default false,
  locale text not null default 'en',
  updated_at timestamptz not null default now()
);

create table if not exists player_progress_snapshots (
  account_id uuid primary key references accounts(account_id) on delete cascade,
  unlocked_level integer not null default 1,
  stars_earned integer not null default 0,
  total_score bigint not null default 0,
  last_level_id integer not null default 1,
  revision integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists offline_practice_operations (
  account_id uuid not null references accounts(account_id) on delete cascade,
  operation_id text not null,
  level_id integer not null,
  score integer not null,
  stars integer not null,
  created_at timestamptz not null default now(),
  primary key (account_id, operation_id)
);

create table if not exists economy_journals (
  journal_id uuid primary key,
  account_id uuid not null references accounts(account_id) on delete cascade,
  idempotency_key text not null unique,
  fingerprint text not null,
  reason text not null,
  reference_id text not null,
  reversal_of uuid references economy_journals(journal_id),
  created_at timestamptz not null default now(),
  unique (reversal_of)
);

create table if not exists economy_journal_lines (
  line_id bigserial primary key,
  journal_id uuid not null references economy_journals(journal_id) on delete restrict,
  ledger_account text not null,
  amount bigint not null
);

create table if not exists inventory_items (
  account_id uuid not null references accounts(account_id) on delete cascade,
  item_id text not null,
  quantity integer not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (account_id, item_id)
);

create table if not exists reward_claims (
  claim_id text primary key,
  account_id uuid not null references accounts(account_id) on delete cascade,
  journal_id uuid not null references economy_journals(journal_id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists payment_intents (
  intent_id uuid primary key,
  account_id uuid not null references accounts(account_id) on delete cascade,
  product_id text not null,
  provider text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists purchase_receipts (
  receipt_id uuid primary key,
  intent_id uuid not null unique references payment_intents(intent_id) on delete restrict,
  provider_event_id text not null unique,
  journal_id uuid not null references economy_journals(journal_id) on delete restrict,
  status text not null,
  wallet_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ad_reward_tokens (
  token_id uuid primary key,
  account_id uuid not null references accounts(account_id) on delete cascade,
  placement text not null,
  provider text not null,
  status text not null,
  expires_at timestamptz not null,
  provider_event_id text unique,
  wallet_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_role_grants_account on role_grants(account_id);
create index if not exists idx_economy_journals_account_created on economy_journals(account_id, created_at desc);
create index if not exists idx_economy_lines_journal on economy_journal_lines(journal_id);
create index if not exists idx_payment_intents_account_created on payment_intents(account_id, created_at desc);
create index if not exists idx_ad_reward_tokens_account_created on ad_reward_tokens(account_id, created_at desc);
