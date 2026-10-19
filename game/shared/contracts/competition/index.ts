export type LeagueTier = 'bronze' | 'silver' | 'gold' | 'diamond';

export type LeaderboardScope =
  | { kind: 'global' }
  | { kind: 'country'; countryCode: string }
  | { kind: 'season'; seasonId: string }
  | { kind: 'classroom'; classroomId: string; rosterRevision: string };

export interface LeaderboardEntry {
  playerId: string;
  displayName: string;
  score: number;
  rank: number;
  achievedAt: string;
}

export interface LeaderboardPage {
  scope: LeaderboardScope;
  entries: LeaderboardEntry[];
  generatedAt: string;
}

export interface RankedPlayerContext {
  playerId: string;
  publicName: string;
  countryCode?: string;
  classroomMemberships: Array<{ classroomId: string; rosterRevision: string }>;
}

export interface VerifiedRankedScore {
  playerId: string;
  runId: string;
  score: number;
  achievedAt: string;
  ranked: true;
  verification: 'server-replay';
  suspicious: false;
}

export interface SeasonSnapshot {
  snapshotId: string;
  seasonId: string;
  closedAt: string;
  entries: LeaderboardEntry[];
}

export interface CompetitionMetaState {
  playerId: string;
  currentStreak: number;
  bestStreak: number;
  shields: number;
  league: LeagueTier;
  leaguePoints: number;
  endlessLevel: number;
  revision: number;
}

export interface RankedOutcome {
  won: boolean;
  endless: boolean;
  verification: 'server-replay';
  eventId?: string;
}
