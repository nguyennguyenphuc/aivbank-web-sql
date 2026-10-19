drop table if exists teaching_assignment_attempts;

alter table teaching_assignments
  drop column if exists rubric_definition,
  drop column if exists journey_definition,
  drop column if exists scenario_revision;

alter table teaching_scenario_packs
  drop column if exists rubric_definition,
  drop column if exists journey_definition;
