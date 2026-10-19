import { boardHash } from './board-hash';
import { createBoard } from './board-state';
import type { BoardConfig, EngineObjective, MoveRecord, ReplayResult } from './engine-types';
import { applyMove } from './turn-engine';

export function replayMoves(
  config: BoardConfig,
  objectives: readonly EngineObjective[],
  moves: readonly MoveRecord[],
): ReplayResult {
  let board = createBoard(config);
  let currentObjectives = objectives.map(item => ({ ...item }));
  let score = 0;
  let acceptedMoves = 0;
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index];
    if (move.index !== index) return invalid(`Move index mismatch at ${index}`, board, currentObjectives, score, acceptedMoves);
    if (move.boardHashBefore !== boardHash(board)) return invalid(`Board hash mismatch before move ${index}`, board, currentObjectives, score, acceptedMoves);
    const turn = applyMove(board, move, currentObjectives, config.colors, index);
    if (!turn.accepted || !turn.record) return invalid(`Rejected move ${index}: ${turn.reason}`, board, currentObjectives, score, acceptedMoves);
    if (move.boardHashAfter !== turn.record.boardHashAfter) return invalid(`Board hash mismatch after move ${index}`, turn.board, turn.objectives, score, acceptedMoves);
    board = turn.board;
    currentObjectives = turn.objectives;
    score += turn.scoreDelta;
    acceptedMoves++;
  }
  return { valid: true, board, objectives: currentObjectives, score, acceptedMoves, finalBoardHash: boardHash(board) };
}

function invalid(
  reason: string,
  board: ReplayResult['board'],
  objectives: EngineObjective[],
  score: number,
  acceptedMoves: number,
): ReplayResult {
  return { valid: false, reason, board, objectives, score, acceptedMoves, finalBoardHash: boardHash(board) };
}
