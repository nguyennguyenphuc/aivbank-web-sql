import { ConflictException, Injectable } from '@nestjs/common';
import type { ExperimentDefinition } from '../../../../shared/contracts/experiments/index.js';

export interface ExperimentRepository {
  publish(definition: ExperimentDefinition): Promise<void>;
  get(experimentId: string, revision: string): Promise<ExperimentDefinition | undefined>;
}

export const EXPERIMENT_REPOSITORY = Symbol('EXPERIMENT_REPOSITORY');

@Injectable()
export class InMemoryExperimentRepository implements ExperimentRepository {
  private readonly definitions = new Map<string, ExperimentDefinition>();

  async publish(definition: ExperimentDefinition): Promise<void> {
    const key = `${definition.experimentId}:${definition.revision}`;
    const existing = this.definitions.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) throw new ConflictException('Experiment revisions are immutable');
    this.definitions.set(key, structuredClone(definition));
  }

  async get(experimentId: string, revision: string): Promise<ExperimentDefinition | undefined> {
    const definition = this.definitions.get(`${experimentId}:${revision}`);
    return definition ? structuredClone(definition) : undefined;
  }
}
