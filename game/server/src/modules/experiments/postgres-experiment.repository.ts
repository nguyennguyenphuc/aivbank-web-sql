import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { ExperimentDefinition } from '../../../../shared/contracts/experiments/index.js';
import { DatabaseService } from '../../database/database.service.js';
import type { ExperimentRepository } from './experiment.repository.js';

interface ExperimentRow { [key: string]: unknown; payload: ExperimentDefinition }

@Injectable()
export class PostgresExperimentRepository implements ExperimentRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async publish(definition: ExperimentDefinition): Promise<void> {
    const current = await this.get(definition.experimentId, definition.revision);
    if (current && JSON.stringify(current) !== JSON.stringify(definition)) throw new ConflictException('Experiment revisions are immutable');
    await this.database.query(
      `insert into experiment_revisions (experiment_id, revision, payload)
       values ($1, $2, $3::jsonb) on conflict do nothing`,
      [definition.experimentId, definition.revision, JSON.stringify(definition)],
    );
  }

  async get(experimentId: string, revision: string): Promise<ExperimentDefinition | undefined> {
    const rows = await this.database.query<ExperimentRow>(
      'select payload from experiment_revisions where experiment_id = $1 and revision = $2',
      [experimentId, revision],
    );
    return rows[0] ? structuredClone(rows[0].payload) : undefined;
  }
}
