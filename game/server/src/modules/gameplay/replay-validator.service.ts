import { Injectable } from '@nestjs/common';
import { replayMoves } from '../../../../shared/engine/replay-engine.js';
import type { BoardConfig, EngineObjective, MoveRecord } from '../../../../shared/engine/engine-types.js';
import type { ServerMoveLog } from './gameplay-types.js';

export interface ServerReplayResult {
  valid: boolean;
  score: number;
  finalBoardHash: string;
  replayDigest: string;
  reason?: string;
  objectives: EngineObjective[];
}

@Injectable()
export class ReplayValidatorService {
  replay(config: BoardConfig, objectives: readonly EngineObjective[], moves: readonly ServerMoveLog[]): ServerReplayResult {
    if (moves.length > 200) return invalid('Move log exceeds 200 entries', objectives);
    if (moves.some(move => !move.boardHashBefore || !move.boardHashAfter)) {
      return invalid('Every move requires before and after board hashes', objectives);
    }
    const replay = replayMoves(config, objectives, moves as MoveRecord[]);
    return {
      valid: replay.valid,
      score: replay.score,
      finalBoardHash: replay.finalBoardHash,
      replayDigest: replay.finalBoardHash,
      reason: replay.reason,
      objectives: replay.objectives,
    };
  }
}

function invalid(reason: string, objectives: readonly EngineObjective[]): ServerReplayResult {
  return { valid: false, reason, score: 0, finalBoardHash: '', replayDigest: '', objectives: objectives.map(item => ({ ...item })) };
}
