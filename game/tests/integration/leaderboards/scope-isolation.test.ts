import { describe, expect, it } from 'vitest';
import type { RankedPlayerContext, VerifiedRankedScore } from '../../../shared/contracts/competition/index.js';
import { InMemoryCompetitionRepository } from '../../../server/src/modules/competition/competition.repository.js';
import { CompetitionService } from '../../../server/src/modules/competition/competition.service.js';
import { InMemoryLeaderboardCache } from '../../../server/src/modules/competition/leaderboard-cache.js';

function setup() {
  const repository = new InMemoryCompetitionRepository();
  return { repository, service: new CompetitionService(repository, new InMemoryLeaderboardCache()) };
}

function score(playerId: string, runId: string, value: number): VerifiedRankedScore {
  return {
    playerId, runId, score: value, achievedAt: '2026-08-28T08:00:00.000Z',
    ranked: true, verification: 'server-replay', suspicious: false,
  };
}

function player(playerId: string, countryCode: string, classroomId: string, rosterRevision: string): RankedPlayerContext {
  return { playerId, publicName: playerId, countryCode, classroomMemberships: [{ classroomId, rosterRevision }] };
}

describe('leaderboard namespace isolation', () => {
  it('isolates country and exact classroom roster revisions', async () => {
    const { service } = setup();
    await service.registerRoster('class-a', 'r1', ['p1']);
    await service.registerRoster('class-a', 'r2', ['p2']);
    await service.recordVerifiedScore(score('p1', 'run-1', 900), player('p1', 'VN', 'class-a', 'r1'), 'season-1');
    await service.recordVerifiedScore(score('p2', 'run-2', 800), player('p2', 'US', 'class-a', 'r2'), 'season-1');

    expect((await service.top({ kind: 'country', countryCode: 'VN' }, 'p2')).entries.map(row => row.playerId)).toEqual(['p1']);
    expect((await service.top({ kind: 'classroom', classroomId: 'class-a', rosterRevision: 'r1' }, 'p1')).entries.map(row => row.playerId)).toEqual(['p1']);
    expect((await service.top({ kind: 'classroom', classroomId: 'class-a', rosterRevision: 'r2' }, 'p2')).entries.map(row => row.playerId)).toEqual(['p2']);
    await expect(service.top({ kind: 'classroom', classroomId: 'class-a', rosterRevision: 'r2' }, 'p1')).rejects.toThrow(/exact roster/i);
  });

  it('rejects client-like score claims that lack the replay-verification boundary', async () => {
    const { service } = setup();
    const forged = { ...score('p1', 'run-1', 999_999), verification: 'client' } as unknown as VerifiedRankedScore;
    await expect(service.recordVerifiedScore(forged, player('p1', 'VN', 'class-a', 'r1'))).rejects.toThrow(/verified/i);
  });
});
