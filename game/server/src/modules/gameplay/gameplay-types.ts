export interface ServerMoveLog {
  index: number;
  from: { row: number; col: number };
  to: { row: number; col: number };
  boardHashBefore?: string;
  boardHashAfter?: string;
}

export interface RunRecord {
  runId: string;
  playerId: string;
  levelId: number;
  contentRevision: string;
  seed: number;
  appVersion: string;
  expiresAt: string;
  submitted: boolean;
  boardConfig: BoardConfig;
  objectives: EngineObjective[];
  moveBudget: number;
}

export interface ReplayCapture {
  runId: string;
  capturedAt: string;
  reason: string;
  seed: number;
  contentRevision: string;
  moves: readonly ServerMoveLog[];
  replayDigest: string;
}
import type { BoardConfig, EngineObjective } from '../../../../shared/engine/engine-types.js';
