import { Client } from 'pg';
import { scryptSync } from 'node:crypto';
import { loadEnv } from '../config/env.js';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(items: readonly T[], next: () => number): T {
  return items[Math.floor(next() * items.length)]!;
}

async function maybeReset(client: Client, reset: boolean): Promise<void> {
  if (!reset) return;
  await client.query(`
    truncate table
      audit_log,
      idempotency_records,
      telemetry_events,
      level_revisions,
      currency_ledger,
      wallets,
      classroom_members,
      classrooms,
      auth_sessions,
      account_identities,
      players,
      accounts,
      leaderboard_entries,
      event_log,
      economy_events,
      tutorial_events,
      level_attempts,
      sessions,
      player_inventory,
      player_progress,
      level_recipes,
      liveops_events,
      experiments,
      competition_leaderboard_entries,
      competition_meta_outcomes,
      competition_meta,
      competition_season_snapshots,
      competition_seasons,
      competition_rosters,
      competition_roster_revisions,
      liveops_inbox_claims,
      liveops_inbox,
      liveops_progress_events,
      liveops_quest_progress,
      liveops_player_state,
      liveops_calendars,
      remote_config_revisions,
      experiment_revisions,
      gameplay_progress_events,
      gameplay_replay_captures,
      gameplay_runs
    restart identity cascade;
  `);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const reset = process.argv.includes('--reset');
  const rng = lcg(20260828);
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('begin');
    await maybeReset(client, reset);

  const platforms = ['android', 'ios'] as const;
  const countries = ['VN', 'TH', 'PH', 'ID', 'US', 'BR'] as const;
  const regions = ['SEA', 'NA', 'LATAM'] as const;
  const difficultyBands = ['easy', 'normal', 'hard', 'super_hard'] as const;
  const objectives = ['score', 'collect_color', 'clear_jelly', 'drop_items'] as const;

    for (let i = 1; i <= 4; i++) {
      const accountId = `01000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const demoAccounts = [
        { email: 'instructor@jelly.local', role: 'instructor' },
        { email: 'analyst@jelly.local', role: 'analyst' },
        { email: 'admin@jelly.local', role: 'admin' },
        { email: 'student@jelly.local', role: 'student' },
      ] as const;
      const demo = demoAccounts[i - 1];
      const salt = `jta-demo-salt-${i}`;
      const passwordHash = `${salt}:${scryptSync('AcademyDemo!2026', salt, 32).toString('hex')}`;
      await client.query(
        `insert into accounts (account_id, email, password_hash, display_name, is_guest, status, created_at, updated_at)
         values ($1, $2, $3, $4, false, 'active', now(), now())
         on conflict (account_id) do update set
           email = excluded.email,
           password_hash = excluded.password_hash,
           display_name = excluded.display_name,
           is_guest = false,
           status = excluded.status,
           updated_at = excluded.updated_at`,
        [accountId, demo.email, passwordHash, `Jelly ${demo.role}`],
      );
      await client.query(
        'insert into role_grants (grant_id, account_id, role) values (gen_random_uuid(), $1, $2) on conflict (account_id, role) do nothing',
        [accountId, demo.role],
      );

      await client.query(
        `insert into wallets (wallet_id, account_id, soft_currency, hard_currency, lifetime_earned, lifetime_spent, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,now(),now())
         on conflict (account_id) do update set
           soft_currency = excluded.soft_currency,
           hard_currency = excluded.hard_currency,
           lifetime_earned = excluded.lifetime_earned,
           lifetime_spent = excluded.lifetime_spent,
           updated_at = excluded.updated_at`,
        [accountId, accountId, 1000 + i * 100, 20 + i * 5, 1500 + i * 120, 300 + i * 20],
      );

      await client.query(
        `insert into classrooms (classroom_id, owner_account_id, classroom_name, join_code, grade_label, status, created_at, updated_at)
         values ($1,$2,$3,$4,$5,'active',now(),now())
         on conflict (classroom_id) do update set
           classroom_name = excluded.classroom_name,
           join_code = excluded.join_code,
           grade_label = excluded.grade_label,
           updated_at = excluded.updated_at`,
        [
          `02000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          accountId,
          `Class ${i}`,
          `JTA-${1000 + i}`,
          `Grade ${3 + i}`,
        ],
      );
    }

    for (let levelId = 1; levelId <= 60; levelId++) {
      const band = difficultyBands[Math.min(difficultyBands.length - 1, Math.floor((levelId - 1) / 15))];
      await client.query(
        `insert into level_recipes (
          level_id, world_key, seed, difficulty_band, rows, cols, moves, objective, board_mask, color_palette, mechanics, version, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
        on conflict (level_id) do update set
          world_key = excluded.world_key,
          seed = excluded.seed,
          difficulty_band = excluded.difficulty_band,
          rows = excluded.rows,
          cols = excluded.cols,
          moves = excluded.moves,
          objective = excluded.objective,
          board_mask = excluded.board_mask,
          color_palette = excluded.color_palette,
          mechanics = excluded.mechanics,
          version = excluded.version,
          created_at = excluded.created_at`,
        [
          levelId,
          `world-${Math.floor((levelId - 1) / 12) + 1}`,
          9000 + levelId,
          band,
          7 + (levelId % 3),
          7 + (levelId % 2),
          16 + Math.floor(levelId / 6),
          JSON.stringify({
            type: pick(objectives, rng),
            target: 10 + (levelId % 10),
          }),
          JSON.stringify({ blocked: [], ice: [] }),
          ['red', 'orange', 'yellow', 'green', 'blue', 'purple'].slice(0, 4 + (levelId % 3)),
          JSON.stringify({
            blockers: levelId % 4,
            boosters: levelId % 5,
          }),
          'dev-seed-v1',
        ],
      );
    }

    for (let i = 1; i <= 12; i++) {
      const playerId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const platform = pick(platforms, rng);
      const country = pick(countries, rng);
      const region = country === 'US' || country === 'BR' ? 'LATAM' : 'SEA';
      await client.query(
        `insert into players (player_id, created_at, platform, country, region, display_name, app_version, status)
         values ($1, now() - ($2::text || ' days')::interval, $3, $4, $5, $6, $7, 'active')
         on conflict (player_id) do update set
           platform = excluded.platform,
           country = excluded.country,
           region = excluded.region,
           display_name = excluded.display_name,
           app_version = excluded.app_version`,
        [
          playerId,
          i,
          platform,
          country,
          region,
          `player_${i}`,
          i <= 6 ? '2.1.0' : '2.1.1',
        ],
      );

      await client.query(
        `insert into player_progress (player_id, unlocked_level, stars_earned, total_score, last_level_id, streak_count, updated_at)
         values ($1,$2,$3,$4,$5,$6,now())
         on conflict (player_id) do update set
           unlocked_level = excluded.unlocked_level,
           stars_earned = excluded.stars_earned,
           total_score = excluded.total_score,
           last_level_id = excluded.last_level_id,
           streak_count = excluded.streak_count,
           updated_at = excluded.updated_at`,
        [playerId, 1 + (i % 18), 3 * (i % 10), 1000 * i, 1 + (i % 12), 1 + (i % 7)],
      );

      await client.query(
        `insert into player_inventory (player_id, coins, boosters, updated_at)
         values ($1,$2,$3,now())
         on conflict (player_id) do update set
           coins = excluded.coins,
           boosters = excluded.boosters,
           updated_at = excluded.updated_at`,
        [
          playerId,
          100 + i * 25,
          JSON.stringify({ hammer: 3, shuffle: 2, lightning: 1, extraMoves: 2 }),
        ],
      );

      const sessionId = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await client.query(
        `insert into sessions (session_id, player_id, started_at, ended_at, platform, country, app_version, entry_point)
         values ($1,$2,now() - ($3::text || ' hours')::interval, now(), $4,$5,$6,$7)`,
        [sessionId, playerId, 2 + i, platform, country, i <= 6 ? '2.1.0' : '2.1.1', 'map'],
      );

      await client.query(
        `insert into tutorial_events (player_id, session_id, step_id, completed, created_at)
         values
          ($1,$2,'welcome',true,now()),
          ($1,$2,'use_hammer', $3, now()),
          ($1,$2,'world_map', true, now())`,
        [playerId, sessionId, i > 3],
      );

      await client.query(
        `insert into level_attempts (
          attempt_id, player_id, level_id, seed, result, score, moves_used, combo_max, booster_used, extra_moves_offered, extra_moves_purchased, started_at, ended_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now() - interval '2 hours', now())`,
        [
          `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          playerId,
          27 + ((i - 1) % 6),
          7000 + i,
          i % 4 === 0 ? 'fail_out_of_moves' : 'complete',
          800 + i * 110,
          14 + (i % 6),
          1 + (i % 5),
          i % 2 === 0,
          1 + (i % 3),
          i % 2,
        ],
      );

      await client.query(
        `insert into economy_events (event_id, player_id, session_id, event_type, product_type, amount_cents, currency, created_at, payload)
         values ($1,$2,$3,'purchase','booster_pack',$4,'USD',now(),$5)`,
        [
          `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          playerId,
          sessionId,
          199 + i * 10,
          JSON.stringify({ source: 'seed', region }),
        ],
      );

      await client.query(
        `insert into leaderboard_entries (board_key, season_key, player_id, score, updated_at)
         values ('global', 'season-1', $1, $2, now())
         on conflict (board_key, season_key, player_id) do update set score = excluded.score, updated_at = excluded.updated_at`,
        [playerId, 5000 + Math.floor(rng() * 5000)],
      );

      await client.query(
        `insert into experiments (assignment_id, player_id, experiment_key, variant_key, assigned_at)
         values ($1,$2,'extra_moves_offer_timing',$3,now())
         on conflict (assignment_id) do nothing`,
        [
          `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          playerId,
          i % 2 === 0 ? 'late' : 'early',
        ],
      );
    }

    await client.query(
      `insert into liveops_events (event_id, event_key, starts_at, ends_at, payload)
       values
        ('50000000-0000-4000-8000-000000000001','launch-burst', now(), now() + interval '7 days', '{"type":"quest","bonus":20}'::jsonb),
        ('50000000-0000-4000-8000-000000000002','weekend-league', now() + interval '1 day', now() + interval '4 days', '{"type":"league","multiplier":1.25}'::jsonb),
        ('50000000-0000-4000-8000-000000000003','hotfix-rollout', now() + interval '8 days', now() + interval '10 days', '{"type":"config","version":"2.1.1"}'::jsonb)
       on conflict (event_key) do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at, payload = excluded.payload`,
    );

    const now = Date.now();
    const startsAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const weekEndsAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
    const seasonEndsAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    const calendar = {
      revision: 'calendar.dev.1',
      publishedAt: new Date(now).toISOString(),
      events: [{ eventId: 'academy-launch', title: 'Đường đua Học viện Kẹo', startsAt, endsAt: seasonEndsAt, bannerKey: 'academy-launch' }],
      quests: [
        { questId: 'daily-play-3', cadence: 'daily', title: 'Chơi 3 màn', metric: 'levels_played', target: 3, reward: { rewardId: 'daily-play-3', soft: 100 }, startsAt, endsAt: weekEndsAt },
        { questId: 'weekly-win-10', cadence: 'weekly', title: 'Thắng 10 màn', metric: 'levels_won', target: 10, reward: { rewardId: 'weekly-win-10', soft: 500, itemId: 'streak-shield', quantity: 1 }, startsAt, endsAt: seasonEndsAt },
      ],
    };
    await client.query('update liveops_calendars set active = false where active');
    await client.query(
      `insert into liveops_calendars (revision, payload, active, published_at)
       values ($1, $2::jsonb, true, $3)
       on conflict (revision) do update set payload = excluded.payload, active = true, published_at = excluded.published_at`,
      [calendar.revision, JSON.stringify(calendar), calendar.publishedAt],
    );

    const remoteConfig = {
      revision: 'config.dev.1', sequence: 1, createdAt: new Date(now).toISOString(), minAppVersion: '0.0.0',
      values: { difficultyMultiplier: 1, offerDelaySeconds: 30, blockedClientRevisions: [], tutorialCopy: { step4: 'Ghép kẹo dưới nguyên liệu để thả xuống.' } },
      killSwitches: { content: false, economy: false, tutorial: false, offers: false, experiments: false },
    };
    await client.query('update remote_config_revisions set active = false where active');
    await client.query(
      `insert into remote_config_revisions (revision, sequence, payload, active, created_at)
       values ($1, $2, $3::jsonb, true, $4)
       on conflict (revision) do update set payload = excluded.payload, active = true, created_at = excluded.created_at`,
      [remoteConfig.revision, remoteConfig.sequence, JSON.stringify(remoteConfig), remoteConfig.createdAt],
    );

    await client.query(
      `insert into telemetry_events (telemetry_event_id, account_id, session_id, event_name, event_date, event_time, payload, created_at, updated_at)
       values
        ('60000000-0000-4000-8000-000000000001', null, null, 'bootstrap', current_date, now(), '{"source":"seed"}'::jsonb, now(), now()),
        ('60000000-0000-4000-8000-000000000002', null, null, 'seed_complete', current_date, now(), '{"status":"ok"}'::jsonb, now(), now())
       on conflict (telemetry_event_id) do update set event_name = excluded.event_name, event_time = excluded.event_time, payload = excluded.payload, updated_at = excluded.updated_at`,
    );

    await client.query('commit');
    // eslint-disable-next-line no-console
    console.log('seed complete');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
}

void main();
