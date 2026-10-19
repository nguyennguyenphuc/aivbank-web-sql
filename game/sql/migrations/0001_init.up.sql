create extension if not exists pgcrypto;

create table if not exists accounts (
  account_id uuid primary key,
  email text unique,
  display_name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists account_identities (
  identity_id uuid primary key,
  account_id uuid not null references accounts(account_id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (provider, provider_subject)
);

create table if not exists auth_sessions (
  session_id uuid primary key,
  account_id uuid not null references accounts(account_id) on delete cascade,
  session_token_hash text not null,
  refresh_token_hash text not null,
  device_id text,
  ip_address inet,
  user_agent text,
  revoked_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists classrooms (
  classroom_id uuid primary key,
  owner_account_id uuid not null references accounts(account_id) on delete cascade,
  classroom_name text not null,
  join_code text not null unique,
  grade_label text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists classroom_members (
  membership_id uuid primary key,
  classroom_id uuid not null references classrooms(classroom_id) on delete cascade,
  account_id uuid not null references accounts(account_id) on delete cascade,
  member_role text not null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (classroom_id, account_id)
);

create table if not exists wallets (
  wallet_id uuid primary key,
  account_id uuid not null references accounts(account_id) on delete cascade,
  soft_currency bigint not null default 0,
  hard_currency bigint not null default 0,
  lifetime_earned bigint not null default 0,
  lifetime_spent bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (account_id)
);

create table if not exists currency_ledger (
  ledger_id uuid primary key,
  wallet_id uuid not null references wallets(wallet_id) on delete cascade,
  account_id uuid not null references accounts(account_id) on delete cascade,
  idempotency_key text not null unique,
  currency_code text not null,
  amount bigint not null,
  reason text not null,
  reference_type text,
  reference_id text,
  balance_before bigint not null,
  balance_after bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists level_revisions (
  level_revision_id uuid primary key,
  level_id int not null,
  revision_number int not null,
  seed bigint not null,
  difficulty_band text not null,
  payload jsonb not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (level_id, revision_number)
);

create table if not exists telemetry_events (
  telemetry_event_id uuid primary key,
  account_id uuid references accounts(account_id) on delete set null,
  session_id uuid references auth_sessions(session_id) on delete set null,
  event_name text not null,
  event_date date not null default current_date,
  event_time timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists idempotency_records (
  idempotency_key text primary key,
  request_hash text not null,
  response_status int,
  response_body jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists audit_log (
  audit_id bigserial primary key,
  actor_account_id uuid references accounts(account_id) on delete set null,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  request_id text not null,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists players (
  player_id uuid primary key,
  created_at timestamptz not null default now(),
  platform text not null check (platform in ('android', 'ios', 'web')),
  country text not null,
  region text not null,
  display_name text not null,
  app_version text not null,
  status text not null default 'active'
);

create table if not exists player_progress (
  player_id uuid primary key references players(player_id) on delete cascade,
  unlocked_level int not null default 1,
  stars_earned int not null default 0,
  total_score bigint not null default 0,
  last_level_id int not null default 1,
  streak_count int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists player_inventory (
  player_id uuid primary key references players(player_id) on delete cascade,
  coins int not null default 0,
  boosters jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists level_recipes (
  level_id int primary key,
  world_key text not null,
  seed bigint not null,
  difficulty_band text not null,
  rows int not null,
  cols int not null,
  moves int not null,
  objective jsonb not null,
  board_mask jsonb not null default '{}'::jsonb,
  color_palette text[] not null,
  mechanics jsonb not null default '{}'::jsonb,
  version text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  session_id uuid primary key,
  player_id uuid not null references players(player_id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  platform text not null,
  country text not null,
  app_version text not null,
  entry_point text not null
);

create table if not exists tutorial_events (
  event_id bigserial primary key,
  player_id uuid not null references players(player_id) on delete cascade,
  session_id uuid references sessions(session_id) on delete set null,
  step_id text not null,
  completed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists level_attempts (
  attempt_id uuid primary key,
  player_id uuid not null references players(player_id) on delete cascade,
  level_id int not null references level_recipes(level_id) on delete cascade,
  seed bigint not null,
  result text not null,
  score int not null default 0,
  moves_used int not null default 0,
  combo_max int not null default 0,
  booster_used boolean not null default false,
  extra_moves_offered int not null default 0,
  extra_moves_purchased int not null default 0,
  started_at timestamptz not null,
  ended_at timestamptz not null
);

create table if not exists economy_events (
  event_id uuid primary key,
  player_id uuid not null references players(player_id) on delete cascade,
  session_id uuid references sessions(session_id) on delete set null,
  event_type text not null,
  product_type text not null,
  amount_cents int not null default 0,
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists leaderboard_entries (
  board_key text not null,
  season_key text not null,
  player_id uuid not null references players(player_id) on delete cascade,
  score bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (board_key, season_key, player_id)
);

create table if not exists experiments (
  assignment_id uuid primary key,
  player_id uuid not null references players(player_id) on delete cascade,
  experiment_key text not null,
  variant_key text not null,
  assigned_at timestamptz not null default now(),
  unique (player_id, experiment_key)
);

create table if not exists liveops_events (
  event_id uuid primary key,
  event_key text not null unique,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb
);

create table if not exists event_log (
  event_id bigserial primary key,
  event_type text not null,
  player_id uuid references players(player_id) on delete set null,
  request_id text not null,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_sessions_player_started on sessions(player_id, started_at desc);
create index if not exists idx_attempts_level_result on level_attempts(level_id, result);
create index if not exists idx_attempts_player_started on level_attempts(player_id, started_at desc);
create index if not exists idx_economy_player_created on economy_events(player_id, created_at desc);
create index if not exists idx_leaderboard_board_season_score on leaderboard_entries(board_key, season_key, score desc);
create index if not exists idx_event_log_type_created on event_log(event_type, created_at desc);
create index if not exists idx_auth_sessions_account_expires on auth_sessions(account_id, expires_at desc);
create index if not exists idx_classrooms_owner_created on classrooms(owner_account_id, created_at desc);
create index if not exists idx_classroom_members_classroom on classroom_members(classroom_id, member_role);
create index if not exists idx_wallets_account on wallets(account_id);
create index if not exists idx_currency_ledger_wallet_created on currency_ledger(wallet_id, created_at desc);
create index if not exists idx_level_revisions_level_created on level_revisions(level_id, revision_number desc);
create index if not exists idx_telemetry_events_account_time on telemetry_events(account_id, event_time desc);
create index if not exists idx_idempotency_expires on idempotency_records(expires_at);
