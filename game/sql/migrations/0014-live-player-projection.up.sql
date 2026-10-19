-- Live AIV Bank players are projected into jelly_analytics with `aivb_` keys
-- (server/src/modules/live-projection). Their daily rollups look rows up by
-- player and day; without these indexes every event scans the synthetic tables.
create index if not exists jelly_sessions_user_day_idx on jelly_analytics.sessions (user_id, event_date);
create index if not exists jelly_attempts_user_day_idx on jelly_analytics.level_attempts (user_id, event_date);
create index if not exists jelly_boosters_user_day_idx on jelly_analytics.booster_events (user_id, event_date);
create index if not exists jelly_purchases_user_day_idx on jelly_analytics.purchases (user_id, event_date);
create index if not exists jelly_ads_user_day_idx on jelly_analytics.ad_events (user_id, event_date);
create index if not exists jelly_daily_user_day_idx on jelly_analytics.player_daily (user_id, activity_date);
