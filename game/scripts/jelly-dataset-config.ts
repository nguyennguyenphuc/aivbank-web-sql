import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const JELLY_TABLES = [
  'users', 'tutorial_steps', 'sessions', 'player_daily', 'level_metadata', 'level_attempts',
  'booster_events', 'purchases', 'ad_events', 'campaign_spend', 'liveops_events',
  'ab_assignments', 'daily_kpi',
] as const;

export type JellyTable = typeof JELLY_TABLES[number];

/**
 * SQL predicate selecting the synthetic (imported) rows of a table. Live AIV Bank
 * players are projected with `aivb_` user ids and KPI days outside the dataset
 * window; everything else belongs to the imported dataset.
 */
export function syntheticRows(table: JellyTable): string {
  switch (table) {
    case 'users': case 'tutorial_steps': case 'sessions': case 'player_daily': case 'level_attempts':
    case 'booster_events': case 'purchases': case 'ad_events': case 'ab_assignments':
      return "user_id NOT LIKE 'aivb\\_%'";
    case 'daily_kpi':
      return "date NOT IN (SELECT activity_date FROM jelly_analytics.player_daily WHERE user_id LIKE 'aivb\\_%')";
    default:
      return 'true';
  }
}

export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function resolveDatasetRoot(): string {
  const configured = argument('source') ?? process.env.JELLY_DATASET_DIR;
  const candidates = configured ? [configured] : [
    path.resolve('Jelly_Trail_Academy_v3_DELIVERY/teaching-materials/student/synthetic_jelly_trail_academy_v3'),
    path.join(os.homedir(), 'Downloads/DA_Game_Teaching_Data/Jelly_Trail_Academy_v3_DELIVERY/teaching-materials/student/synthetic_jelly_trail_academy_v3'),
  ];
  const found = candidates.find(candidate => fs.existsSync(path.join(candidate, 'manifest.json')) && fs.existsSync(path.join(candidate, 'data')));
  if (!found) throw new Error('Jelly dataset not found; pass --source or set JELLY_DATASET_DIR');
  return path.resolve(found);
}

export function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
