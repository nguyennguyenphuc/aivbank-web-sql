import { createEngineDefinition } from '../server/src/modules/content/engine-definition.js';
import { CANONICAL_CAMPAIGN, issueEndlessSeed } from '../shared/contracts/content/index.js';
import { createBoard, findPossibleMove } from '../shared/engine/index.js';

let checked = 0;
for (const level of CANONICAL_CAMPAIGN) {
  verifyBoard(level.levelId, level.seed);
}
for (let ladderLevel = 1; ladderLevel <= 500; ladderLevel++) {
  const issue = issueEndlessSeed(ladderLevel, 20260828);
  verifyBoard(((ladderLevel - 1) % 60) + 1, issue.seed);
}

console.log(JSON.stringify({ ok: true, checked, canonical: 60, endless: 500 }));

function verifyBoard(levelId: number, seed: number): void {
  const definition = createEngineDefinition(levelId, seed);
  const board = createBoard(definition.board);
  if (!findPossibleMove(board)) throw new Error(`Level ${levelId} seed ${seed} has no opening move`);
  if (definition.moveBudget < 1 || definition.objectives.length === 0) {
    throw new Error(`Level ${levelId} has invalid budget/objectives`);
  }
  checked++;
}
