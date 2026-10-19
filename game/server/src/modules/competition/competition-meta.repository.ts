import type { CompetitionMetaState } from '../../../../shared/contracts/competition/index.js';

export interface CompetitionMetaRepository {
  get(playerId: string): Promise<CompetitionMetaState | undefined>;
  save(state: CompetitionMetaState, expectedRevision: number): Promise<void>;
  saveOutcome(state: CompetitionMetaState, expectedRevision: number, eventId: string): Promise<boolean>;
}

export const COMPETITION_META_REPOSITORY = Symbol('COMPETITION_META_REPOSITORY');

export class InMemoryCompetitionMetaRepository implements CompetitionMetaRepository {
  private readonly states = new Map<string, CompetitionMetaState>();
  private readonly outcomes = new Set<string>();

  async get(playerId: string): Promise<CompetitionMetaState | undefined> {
    const state = this.states.get(playerId);
    return state ? structuredClone(state) : undefined;
  }

  async save(state: CompetitionMetaState, expectedRevision: number): Promise<void> {
    const current = this.states.get(state.playerId);
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error('Competition meta revision conflict');
    this.states.set(state.playerId, structuredClone(state));
  }

  async saveOutcome(state: CompetitionMetaState, expectedRevision: number, eventId: string): Promise<boolean> {
    const key = `${state.playerId}:${eventId}`;
    if (this.outcomes.has(key)) return false;
    await this.save(state, expectedRevision);
    this.outcomes.add(key);
    return true;
  }
}
