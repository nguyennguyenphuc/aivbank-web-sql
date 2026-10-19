create table competition_meta_outcomes (
  player_id text not null,
  event_id text not null,
  applied_at timestamptz not null default now(),
  primary key (player_id, event_id)
);
