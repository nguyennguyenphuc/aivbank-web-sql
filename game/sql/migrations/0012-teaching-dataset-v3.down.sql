drop table jelly_analytics.dataset_metadata;

alter table jelly_analytics.ab_assignments
  drop column eligible_at,
  drop column exposed_at,
  drop column exposure_status,
  drop column eligibility_rule,
  drop column primary_metric,
  drop column guardrail_metric,
  drop column analysis_window_days;
