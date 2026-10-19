import { BadRequestException } from '@nestjs/common';
import type { LeaderboardScope } from '../../../../shared/contracts/competition/index.js';

const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;

export function leaderboardNamespace(scope: LeaderboardScope): string {
  if (scope.kind === 'global') return 'leaderboard:global';
  if (scope.kind === 'country') {
    const country = scope.countryCode.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new BadRequestException('countryCode must be ISO alpha-2');
    return `leaderboard:country:${country}`;
  }
  if (scope.kind === 'season') {
    assertSafe(scope.seasonId, 'seasonId');
    return `leaderboard:season:${scope.seasonId}`;
  }
  assertSafe(scope.classroomId, 'classroomId');
  assertSafe(scope.rosterRevision, 'rosterRevision');
  return `leaderboard:classroom:${scope.classroomId}:roster:${scope.rosterRevision}`;
}

function assertSafe(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new BadRequestException(`${name} is invalid`);
}
