import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveDatasetRoot } from '../../scripts/jelly-dataset-config';
import { describe, expect, it } from 'vitest';

const database = path.join(resolveDatasetRoot(), 'jelly_trail_academy_v3_game_da.sqlite');

function query(sql: string): Array<{ app_version: string; metric: number }> {
  const output = execFileSync('sqlite3', ['-json', database, sql], { encoding: 'utf8' });
  return JSON.parse(output) as Array<{ app_version: string; metric: number }>;
}

describe('Jelly Trail teaching scenario', () => {
  it('preserves the Android SEA v2.1.0 tutorial regression and v2.1.1 recovery', () => {
    const rows = query(`select app_version, avg(cast(step_completed as real)) metric from tutorial_steps
      where step_id='4' and platform='Android' and country in ('VN','TH','PH','ID') group by app_version`);
    const metric = Object.fromEntries(rows.map(row => [row.app_version, row.metric]));
    expect(metric['2.1.0']).toBeLessThan(metric['2.0.2']);
    expect(metric['2.1.1']).toBeGreaterThan(metric['2.1.0']);
  });

  it('preserves the levels 28-30 difficulty spike', () => {
    const rows = query(`select app_version, avg(case when result='complete' then 1.0 else 0 end) metric from level_attempts
      where level_id in ('28','29','30') and platform='Android' and country in ('VN','TH','PH','ID') group by app_version`);
    const metric = Object.fromEntries(rows.map(row => [row.app_version, row.metric]));
    expect(metric['2.1.0']).toBeLessThan(metric['2.0.2']);
  });
});
