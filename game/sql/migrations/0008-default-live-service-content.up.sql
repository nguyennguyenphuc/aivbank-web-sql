insert into liveops_calendars (revision, payload, active, published_at)
values (
  'calendar.default.1',
  jsonb_build_object(
    'revision', 'calendar.default.1',
    'publishedAt', now()::text,
    'events', jsonb_build_array(jsonb_build_object(
      'eventId', 'academy-launch', 'title', 'Đường đua Học viện Kẹo',
      'startsAt', (now() - interval '1 day')::text, 'endsAt', (now() + interval '365 days')::text,
      'bannerKey', 'academy-launch'
    )),
    'quests', jsonb_build_array(
      jsonb_build_object('questId', 'daily-play-3', 'cadence', 'daily', 'title', 'Chơi 3 màn', 'metric', 'levels_played', 'target', 3,
        'reward', jsonb_build_object('rewardId', 'daily-play-3', 'soft', 100), 'startsAt', (now() - interval '1 day')::text, 'endsAt', (now() + interval '365 days')::text),
      jsonb_build_object('questId', 'weekly-win-10', 'cadence', 'weekly', 'title', 'Thắng 10 màn', 'metric', 'levels_won', 'target', 10,
        'reward', jsonb_build_object('rewardId', 'weekly-win-10', 'soft', 500, 'itemId', 'streak-shield', 'quantity', 1), 'startsAt', (now() - interval '1 day')::text, 'endsAt', (now() + interval '365 days')::text)
    )
  ),
  not exists (select 1 from liveops_calendars where active),
  now()
)
on conflict (revision) do nothing;

insert into remote_config_revisions (revision, sequence, payload, active, created_at)
values (
  'config.default.1', 1,
  jsonb_build_object(
    'revision', 'config.default.1', 'sequence', 1, 'createdAt', now()::text, 'minAppVersion', '0.1.0',
    'values', jsonb_build_object('difficultyMultiplier', 1, 'offerDelaySeconds', 30, 'blockedClientRevisions', '[]'::jsonb,
      'tutorialCopy', jsonb_build_object('step4', 'Ghép kẹo dưới nguyên liệu để thả xuống.')),
    'killSwitches', jsonb_build_object('content', false, 'economy', false, 'tutorial', false, 'offers', false, 'experiments', false)
  ),
  not exists (select 1 from remote_config_revisions where active),
  now()
)
on conflict (revision) do nothing;
