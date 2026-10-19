import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { CompetitionMetaState, LeagueTier, RankedOutcome } from '../../../../shared/contracts/competition/index.js';
import { COMPETITION_META_REPOSITORY, type CompetitionMetaRepository } from './competition-meta.repository.js';

const LEAGUES: LeagueTier[] = ['bronze', 'silver', 'gold', 'diamond'];

@Injectable()
export class CompetitionMetaService {
  constructor(@Inject(COMPETITION_META_REPOSITORY) private readonly repository: CompetitionMetaRepository) {}

  async get(playerId: string): Promise<CompetitionMetaState> {
    return await this.repository.get(playerId) ?? {
      playerId, currentStreak: 0, bestStreak: 0, shields: 0,
      league: 'bronze', leaguePoints: 0, endlessLevel: 1, revision: 0,
    };
  }

  async applyOutcome(playerId: string, outcome: RankedOutcome): Promise<CompetitionMetaState & { shieldConsumed: boolean }> {
    if (outcome.verification !== 'server-replay') throw new BadRequestException('Outcome must be server verified');
    const state = await this.get(playerId);
    const expectedRevision = state.revision;
    let shieldConsumed = false;
    if (outcome.won) {
      state.currentStreak += 1;
      state.bestStreak = Math.max(state.bestStreak, state.currentStreak);
      state.leaguePoints += 3;
      if (outcome.endless) state.endlessLevel += 1;
    } else {
      if (state.currentStreak > 0 && state.shields > 0) {
        state.shields -= 1;
        shieldConsumed = true;
      } else state.currentStreak = 0;
      state.leaguePoints = Math.max(0, state.leaguePoints - 1);
      if (outcome.endless) state.endlessLevel = Math.max(1, state.endlessLevel - 1);
    }
    state.revision += 1;
    if (outcome.eventId) {
      const applied = await this.repository.saveOutcome(state, expectedRevision, outcome.eventId);
      if (!applied) return { ...await this.get(playerId), shieldConsumed: false };
    } else {
      await this.repository.save(state, expectedRevision);
    }
    return { ...state, shieldConsumed };
  }

  async awardShield(playerId: string, count = 1): Promise<CompetitionMetaState> {
    if (!Number.isInteger(count) || count < 1) throw new BadRequestException('count must be positive');
    const state = await this.get(playerId);
    const expectedRevision = state.revision;
    state.shields = Math.min(3, state.shields + count);
    state.revision += 1;
    await this.repository.save(state, expectedRevision);
    return state;
  }

  async settleLeague(playerId: string, position: number, participantCount: number): Promise<CompetitionMetaState> {
    if (!Number.isInteger(position) || !Number.isInteger(participantCount) || position < 1 || position > participantCount) {
      throw new BadRequestException('Invalid league standing');
    }
    const state = await this.get(playerId);
    const expectedRevision = state.revision;
    const index = LEAGUES.indexOf(state.league);
    const percentile = position / participantCount;
    if (percentile <= 0.2) state.league = LEAGUES[Math.min(LEAGUES.length - 1, index + 1)];
    else if (percentile > 0.8) state.league = LEAGUES[Math.max(0, index - 1)];
    state.leaguePoints = 0;
    state.revision += 1;
    await this.repository.save(state, expectedRevision);
    return state;
  }
}
