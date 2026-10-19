import { describe, expect, it } from 'vitest';
import { InMemoryCompetitionMetaRepository } from '../../../server/src/modules/competition/competition-meta.repository.js';
import { CompetitionMetaService } from '../../../server/src/modules/competition/competition-meta.service.js';
import { InMemoryCompetitionRepository } from '../../../server/src/modules/competition/competition.repository.js';
import { CompetitionService } from '../../../server/src/modules/competition/competition.service.js';
import { InMemoryLeaderboardCache } from '../../../server/src/modules/competition/leaderboard-cache.js';

describe('season snapshots and competition meta', () => {
  it('preserves a closed snapshot while a new season starts empty', async () => {
    const service = new CompetitionService(new InMemoryCompetitionRepository(), new InMemoryLeaderboardCache());
    const player = { playerId: 'p1', publicName: 'P1', countryCode: 'VN', classroomMemberships: [] };
    await service.recordVerifiedScore({
      playerId: 'p1', runId: 'run-s1', score: 500, achievedAt: '2026-08-28T00:00:00Z',
      ranked: true, verification: 'server-replay', suspicious: false,
    }, player, 'season-1');
    const snapshot = await service.closeSeason('season-1', '2026-09-01T00:00:00Z');

    expect(snapshot.entries[0]).toMatchObject({ playerId: 'p1', rank: 1, score: 500 });
    await expect(service.recordVerifiedScore({
      playerId: 'p1', runId: 'late-run', score: 700, achievedAt: '2026-09-02T00:00:00Z',
      ranked: true, verification: 'server-replay', suspicious: false,
    }, player, 'season-1')).rejects.toThrow(/closed/i);
    expect((await service.top({ kind: 'season', seasonId: 'season-2' }, 'p1')).entries).toEqual([]);
    expect((await service.closeSeason('season-1', '2026-10-01T00:00:00Z')).snapshotId).toBe(snapshot.snapshotId);
  });

  it('consumes a shield before breaking a streak and advances the endless ladder only on wins', async () => {
    const meta = new CompetitionMetaService(new InMemoryCompetitionMetaRepository());
    await meta.awardShield('p1');
    await meta.applyOutcome('p1', { won: true, endless: true, verification: 'server-replay' });
    const loss = await meta.applyOutcome('p1', { won: false, endless: true, verification: 'server-replay' });
    expect(loss).toMatchObject({ currentStreak: 1, shields: 0, shieldConsumed: true, endlessLevel: 1 });
    expect((await meta.applyOutcome('p1', { won: false, endless: false, verification: 'server-replay' })).currentStreak).toBe(0);
  });
});
