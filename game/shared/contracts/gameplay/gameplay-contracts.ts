export interface Coordinate { row: number; col: number }

export interface MoveLogEntry {
  index: number;
  from: Coordinate;
  to: Coordinate;
  boardHashBefore?: string;
  boardHashAfter?: string;
}

export interface StartRunRequest {
  playerId: string;
  levelId: number;
  contentRevision: string;
  appVersion: string;
}

export interface StartRunResponse {
  runId: string;
  seed: number;
  levelId: number;
  contentRevision: string;
  runToken: string;
  expiresAt: string;
}

export interface SubmitRunRequest {
  runId: string;
  runToken: string;
  moves: MoveLogEntry[];
  claimedScore: number;
  claimedWon: boolean;
}

export interface SubmitRunResponse {
  accepted: boolean;
  suspicious: boolean;
  authoritativeScore: number;
  authoritativeWon: boolean;
  finalBoardHash: string;
  reason?: string;
}

export interface SuspiciousReplayCapture {
  runId: string;
  capturedAt: string;
  reason: string;
  moves: readonly MoveLogEntry[];
}
