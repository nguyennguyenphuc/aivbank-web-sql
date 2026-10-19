create table gameplay_runs (
  run_id uuid primary key,
  player_id text not null,
  level_id integer not null,
  content_revision text not null,
  seed bigint not null,
  app_version text not null,
  expires_at timestamptz not null,
  submitted boolean not null default false,
  board_config jsonb not null,
  objectives jsonb not null,
  move_budget integer not null,
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);
create index gameplay_runs_player_created_idx on gameplay_runs (player_id, created_at desc);
create index gameplay_runs_expiry_idx on gameplay_runs (expires_at) where not submitted;

create table gameplay_replay_captures (
  run_id uuid primary key references gameplay_runs(run_id) on delete cascade,
  payload jsonb not null,
  captured_at timestamptz not null
);

create table gameplay_progress_events (
  run_id uuid primary key references gameplay_runs(run_id) on delete cascade,
  account_id uuid not null references accounts(account_id) on delete cascade,
  level_id integer not null,
  score integer not null check (score >= 0),
  won boolean not null,
  created_at timestamptz not null default now()
);
create index gameplay_progress_events_account_idx on gameplay_progress_events (account_id, created_at desc);
