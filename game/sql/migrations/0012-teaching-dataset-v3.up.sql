alter table jelly_analytics.ab_assignments
  add column eligible_at text,
  add column exposed_at text,
  add column exposure_status text,
  add column eligibility_rule text,
  add column primary_metric text,
  add column guardrail_metric text,
  add column analysis_window_days text;

create table jelly_analytics.dataset_metadata (
  singleton boolean primary key default true check (singleton),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  imported_at timestamptz not null default now()
);
