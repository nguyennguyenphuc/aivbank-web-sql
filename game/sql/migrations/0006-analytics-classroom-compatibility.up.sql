create schema if not exists jelly_analytics;

create table jelly_analytics.users (
  user_id text primary key, install_date text, platform text, country text, channel text,
  campaign_id text, app_version_install text, device_tier text
);
create table jelly_analytics.tutorial_steps (
  user_id text, install_date text, event_time text, event_date text, session_id text,
  step_id text, step_name text, screen_context text, step_completed text, platform text,
  country text, channel text, app_version text
);
create table jelly_analytics.sessions (
  session_id text primary key, user_id text, session_start text, event_date text, event_time text,
  duration_minutes text, entry_screen text, app_version text, platform text, country text
);
create table jelly_analytics.player_daily (
  user_id text, install_date text, activity_date text, cohort_day text, platform text, country text,
  channel text, campaign_id text, app_version text, sessions text, playtime_minutes text,
  max_level text, boosters_used text, extra_moves_purchased text, crash_count text,
  iap_revenue text, ad_revenue text
);
create table jelly_analytics.level_metadata (
  level_id text primary key, episode text, world_name text, screen_context text, objective_type text,
  difficulty_tag text, moves_limit text, designed_fail_probability text, teaching_note text
);
create table jelly_analytics.level_attempts (
  attempt_id text primary key, user_id text, event_date text, event_time text, session_id text,
  level_id text, episode text, world_name text, screen_context text, objective_type text,
  difficulty_tag text, moves_limit text, moves_used text, moves_left text, result text,
  booster_used text, extra_moves_offered text, extra_moves_purchased text, duration_sec text,
  app_version text, platform text, country text
);
create table jelly_analytics.booster_events (
  booster_event_id text primary key, attempt_id text, user_id text, event_date text, event_time text,
  session_id text, level_id text, booster_type text, action text, screen_context text,
  app_version text, platform text, country text
);
create table jelly_analytics.purchases (
  transaction_id text primary key, user_id text, event_date text, event_time text, session_id text,
  product_type text, product_name text, price_usd text, level_id_if_relevant text,
  screen_context text, currency text, is_refund text, app_version text, platform text, country text
);
create table jelly_analytics.ad_events (
  ad_id text primary key, user_id text, event_date text, event_time text, session_id text,
  ad_type text, placement text, reward_type text, revenue_usd text, screen_context text,
  app_version text, platform text, country text
);
create table jelly_analytics.campaign_spend (
  date text, campaign_id text, channel text, country text, spend_usd text, target_platform text
);
create table jelly_analytics.liveops_events (
  event_id text primary key, event_name text, start_date text, end_date text, screen_context text, mechanic text
);
create table jelly_analytics.ab_assignments (
  user_id text, experiment_id text, variant text, assigned_at text, platform text, country text,
  primary key (user_id, experiment_id)
);
create table jelly_analytics.daily_kpi (
  date text primary key, dau text, new_users text, sessions text, playtime_minutes text,
  iap_revenue text, ad_revenue text, crash_count text, arpdau text
);

create index jelly_tutorial_segment_idx on jelly_analytics.tutorial_steps (step_id, app_version, platform, country);
create index jelly_attempt_segment_idx on jelly_analytics.level_attempts (level_id, app_version, platform, country, result);
create index jelly_daily_cohort_idx on jelly_analytics.player_daily (cohort_day, app_version, platform, country);

create table analytics_event_spine (
  event_id text primary key,
  player_hash text not null,
  event_name text not null,
  schema_version integer not null check (schema_version > 0),
  occurred_at timestamptz not null,
  payload jsonb not null,
  source text not null,
  received_at timestamptz not null default now()
);
create index analytics_event_spine_time_idx on analytics_event_spine (occurred_at, event_name);

create table teaching_scenario_packs (
  scenario_id text primary key,
  title text not null,
  description text not null,
  filters jsonb not null,
  learning_objectives jsonb not null,
  immutable_revision text not null,
  created_at timestamptz not null default now()
);
create table teaching_classrooms (
  classroom_id text primary key,
  owner_account_id text not null,
  name text not null,
  join_code text not null unique,
  roster_revision text not null,
  created_at timestamptz not null default now()
);
create table teaching_classroom_members (
  classroom_id text not null references teaching_classrooms(classroom_id) on delete cascade,
  account_id text not null,
  role text not null check (role in ('teacher', 'student')),
  joined_at timestamptz not null default now(),
  primary key (classroom_id, account_id)
);
create table teaching_assignments (
  assignment_id text primary key,
  classroom_id text not null references teaching_classrooms(classroom_id) on delete cascade,
  scenario_id text not null references teaching_scenario_packs(scenario_id),
  title text not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (opens_at < closes_at)
);

insert into teaching_scenario_packs (scenario_id, title, description, filters, learning_objectives, immutable_revision)
values
  ('android-sea-v2.1.0-regression', 'Android SEA v2.1.0 Regression',
   'Investigate tutorial step 4 confusion and levels 28-30 friction introduced in v2.1.0.',
   '{"platform":"Android","countries":["VN","TH","PH","ID"],"appVersion":"2.1.0","levels":[28,29,30],"tutorialStep":"4"}'::jsonb,
   '["funnel analysis","level difficulty diagnosis","retention impact","evidence-backed recommendation"]'::jsonb, 'scenario.v1'),
  ('android-sea-v2.1.1-hotfix', 'Android SEA v2.1.1 Hotfix',
   'Measure whether v2.1.1 recovers activation, win rate, and retention without hiding remaining friction.',
   '{"platform":"Android","countries":["VN","TH","PH","ID"],"appVersion":"2.1.1","compareTo":"2.1.0","levels":[28,29,30],"tutorialStep":"4"}'::jsonb,
   '["before-after analysis","guardrail metrics","partial recovery assessment"]'::jsonb, 'scenario.v1');

create view jelly_analytics.tutorial_step4_health as
select app_version, platform,
  case when country in ('VN','TH','PH','ID') then 'SEA' else 'Other' end region,
  avg(case when step_completed = '1' then 1.0 else 0.0 end) completion_rate,
  count(*) rows
from jelly_analytics.tutorial_steps where step_id = '4'
group by app_version, platform, region;

create view jelly_analytics.level_28_30_health as
select app_version, platform,
  case when country in ('VN','TH','PH','ID') then 'SEA' else 'Other' end region,
  avg(case when result = 'complete' then 1.0 else 0.0 end) win_rate,
  avg(case when result <> 'complete' then 1.0 else 0.0 end) non_complete_rate,
  count(*) attempts
from jelly_analytics.level_attempts where level_id in ('28','29','30')
group by app_version, platform, region;
