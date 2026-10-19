create table competition_roster_revisions (
  classroom_id text not null,
  roster_revision text not null,
  created_at timestamptz not null default now(),
  primary key (classroom_id, roster_revision)
);

create table competition_rosters (
  classroom_id text not null,
  roster_revision text not null,
  player_id text not null,
  created_at timestamptz not null default now(),
  primary key (classroom_id, roster_revision, player_id),
  foreign key (classroom_id, roster_revision) references competition_roster_revisions(classroom_id, roster_revision)
);

create table competition_leaderboard_entries (
  namespace text not null,
  player_id text not null,
  display_name text not null,
  score bigint not null check (score >= 0),
  achieved_at timestamptz not null,
  source_run_id text not null,
  updated_at timestamptz not null default now(),
  primary key (namespace, player_id),
  unique (namespace, source_run_id)
);
create index competition_leaderboard_entries_rank_idx on competition_leaderboard_entries (namespace, score desc, player_id);

create table competition_seasons (
  season_id text primary key,
  status text not null check (status in ('open', 'closed')),
  closed_at timestamptz
);

create table competition_season_snapshots (
  snapshot_id text primary key,
  season_id text not null unique,
  closed_at timestamptz not null,
  entries jsonb not null
);

create table competition_meta (
  player_id text primary key,
  current_streak integer not null default 0,
  best_streak integer not null default 0,
  shields integer not null default 0 check (shields between 0 and 3),
  league text not null default 'bronze' check (league in ('bronze', 'silver', 'gold', 'diamond')),
  league_points integer not null default 0,
  endless_level integer not null default 1,
  revision integer not null default 0,
  updated_at timestamptz not null default now()
);

create table liveops_calendars (
  revision text primary key,
  payload jsonb not null,
  active boolean not null default false,
  published_at timestamptz not null
);
create unique index liveops_one_active_calendar_idx on liveops_calendars (active) where active;

create table liveops_quest_progress (
  player_id text not null,
  quest_id text not null,
  progress integer not null default 0,
  claimed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (player_id, quest_id)
);

create table liveops_progress_events (
  player_id text not null,
  event_id text not null,
  recorded_at timestamptz not null default now(),
  primary key (player_id, event_id)
);

create table liveops_inbox (
  message_id text primary key,
  account_id text,
  payload jsonb not null,
  available_at timestamptz not null,
  expires_at timestamptz not null
);
create index liveops_inbox_account_idx on liveops_inbox (account_id, available_at, expires_at);

create table liveops_inbox_claims (
  player_id text not null,
  message_id text not null references liveops_inbox(message_id),
  claimed_at timestamptz not null default now(),
  primary key (player_id, message_id)
);

create table liveops_player_state (
  player_id text primary key,
  last_seen_at timestamptz not null
);

create table remote_config_revisions (
  revision text primary key,
  sequence integer not null unique,
  payload jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null
);
create unique index remote_config_one_active_idx on remote_config_revisions (active) where active;

create table experiment_revisions (
  experiment_id text not null,
  revision text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (experiment_id, revision)
);
