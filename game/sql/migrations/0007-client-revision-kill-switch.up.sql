update remote_config_revisions
set payload = jsonb_set(
  jsonb_set(payload, '{values,blockedClientRevisions}', '[]'::jsonb, true),
  '{killSwitches}',
  '{"content":false,"economy":false,"tutorial":false,"offers":false,"experiments":false}'::jsonb,
  true
)
where revision = 'config.dev.1';
