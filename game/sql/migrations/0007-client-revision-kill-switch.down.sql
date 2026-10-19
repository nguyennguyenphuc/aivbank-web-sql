update remote_config_revisions
set payload = (payload #- '{values,blockedClientRevisions}')
where revision = 'config.dev.1';
