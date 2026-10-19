import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  ExperimentAssignment, ExperimentDefinition, ExperimentVariant,
} from '../../../../shared/contracts/experiments/index.js';
import { EXPERIMENT_REPOSITORY, type ExperimentRepository } from './experiment.repository.js';

@Injectable()
export class ExperimentService {
  constructor(@Inject(EXPERIMENT_REPOSITORY) private readonly repository: ExperimentRepository) {}

  async publish(definition: ExperimentDefinition): Promise<void> {
    if (!definition.experimentId.trim() || !definition.revision.trim() || !definition.salt.trim()) throw new BadRequestException('Invalid experiment identity');
    if (!Number.isInteger(definition.rolloutBps) || definition.rolloutBps < 0 || definition.rolloutBps > 10_000) {
      throw new BadRequestException('rolloutBps must be from 0 to 10000');
    }
    if (!definition.variants.length || definition.variants.reduce((sum, variant) => sum + variant.weightBps, 0) !== 10_000) {
      throw new BadRequestException('Variant weights must total 10000 basis points');
    }
    if (definition.variants.some(variant => !variant.key.trim() || variant.weightBps < 0)) throw new BadRequestException('Invalid variant');
    await this.repository.publish(definition);
  }

  async assign(input: {
    experimentId: string;
    revision: string;
    subjectId: string;
    countryCode?: string;
    experimentsKilled?: boolean;
  }): Promise<ExperimentAssignment> {
    if (!input.subjectId.trim()) throw new BadRequestException('subjectId is required');
    const definition = await this.repository.get(input.experimentId, input.revision);
    if (!definition) throw new NotFoundException('Experiment revision not found');
    const eligible = definition.enabled && !input.experimentsKilled
      && (!definition.countryCodes || Boolean(input.countryCode && definition.countryCodes.includes(input.countryCode.toUpperCase())))
      && bucket(definition, input.subjectId, 'rollout') < definition.rolloutBps;
    const variant = eligible ? selectVariant(definition, input.subjectId) : controlVariant(definition.variants);
    return {
      experimentId: definition.experimentId,
      revision: definition.revision,
      variant: variant.key,
      payload: structuredClone(variant.payload),
      eligible,
    };
  }
}

function selectVariant(definition: ExperimentDefinition, subjectId: string): ExperimentVariant {
  const value = bucket(definition, subjectId, 'variant');
  let upper = 0;
  for (const variant of definition.variants) {
    upper += variant.weightBps;
    if (value < upper) return variant;
  }
  return definition.variants[definition.variants.length - 1];
}

function controlVariant(variants: ExperimentVariant[]): ExperimentVariant {
  return variants.find(variant => variant.key === 'control') ?? variants[0];
}

function bucket(definition: ExperimentDefinition, subjectId: string, purpose: string): number {
  const digest = createHash('sha256')
    .update(`${definition.salt}:${definition.experimentId}:${definition.revision}:${purpose}:${subjectId}`)
    .digest();
  return digest.readUInt32BE(0) % 10_000;
}
