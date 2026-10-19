import { describe, expect, it } from 'vitest';
import type { ExperimentDefinition, RemoteConfigRevision } from '../../../shared/contracts/experiments/index.js';
import { InMemoryExperimentRepository } from '../../../server/src/modules/experiments/experiment.repository.js';
import { ExperimentService } from '../../../server/src/modules/experiments/experiment.service.js';
import { InMemoryRemoteConfigRepository } from '../../../server/src/modules/experiments/remote-config.repository.js';
import { RemoteConfigService } from '../../../server/src/modules/experiments/remote-config.service.js';

function config(revision: string, sequence: number, difficultyMultiplier: number): RemoteConfigRevision {
  return {
    revision, sequence, createdAt: `2026-08-${String(sequence).padStart(2, '0')}T00:00:00Z`,
    values: { tutorialCopy: { welcome: revision }, difficultyMultiplier, offerDelaySeconds: 30 },
    killSwitches: { content: false, economy: false, tutorial: false, offers: false, experiments: false },
  };
}

describe('remote config and experiments', () => {
  it('rejects stale activation and rolls back by publishing a new immutable revision', async () => {
    const repository = new InMemoryRemoteConfigRepository();
    const service = new RemoteConfigService(repository);
    await service.publish(config('config.1', 1, 1));
    await service.publish(config('config.2', 2, 1.2), 'config.1');
    await expect(repository.activate('config.1', 'config.2')).rejects.toThrow(/stale/i);
    const rollback = await service.rollback('config.1', 'config.3', 'config.2');
    expect(rollback).toMatchObject({ revision: 'config.3', sequence: 3, rolledBackFrom: 'config.2' });
    expect((await service.resolve('2.1.1')).config?.values.difficultyMultiplier).toBe(1);
  });

  it('assigns the same subject deterministically and honors experiment kill switches', async () => {
    const service = new ExperimentService(new InMemoryExperimentRepository());
    const definition: ExperimentDefinition = {
      experimentId: 'tutorial-copy', revision: '1', salt: 'stable-salt', enabled: true, rolloutBps: 10_000,
      variants: [
        { key: 'control', weightBps: 5000, payload: { title: 'Welcome' } },
        { key: 'friendly', weightBps: 5000, payload: { title: 'Hello' } },
      ],
    };
    await service.publish(definition);
    const first = await service.assign({ experimentId: 'tutorial-copy', revision: '1', subjectId: 'p1' });
    expect(await service.assign({ experimentId: 'tutorial-copy', revision: '1', subjectId: 'p1' })).toEqual(first);
    expect((await service.assign({ experimentId: 'tutorial-copy', revision: '1', subjectId: 'p1', experimentsKilled: true }))).toMatchObject({ variant: 'control', eligible: false });
  });
});
