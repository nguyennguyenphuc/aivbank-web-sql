import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RemoteConfigRevision } from '../../../../shared/contracts/experiments/index.js';
import { REMOTE_CONFIG_REPOSITORY, type RemoteConfigRepository } from './remote-config.repository.js';

@Injectable()
export class RemoteConfigService {
  constructor(@Inject(REMOTE_CONFIG_REPOSITORY) private readonly repository: RemoteConfigRepository) {}

  async publish(config: RemoteConfigRevision, expectedActiveRevision?: string): Promise<RemoteConfigRevision> {
    validateConfig(config);
    const existing = await this.repository.get(config.revision);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(config)) throw new BadRequestException('Config revision already exists with different content');
      return existing;
    }
    const latest = await this.repository.latestSequence();
    if (config.sequence <= latest) throw new BadRequestException('Config sequence must increase');
    await this.repository.publish(config);
    await this.repository.activate(config.revision, expectedActiveRevision);
    return structuredClone(config);
  }

  async rollback(targetRevision: string, newRevision: string, expectedActiveRevision: string): Promise<RemoteConfigRevision> {
    const target = await this.repository.get(targetRevision);
    const active = await this.repository.active();
    if (!target || !active) throw new NotFoundException('Rollback revision not found');
    const rollback: RemoteConfigRevision = {
      ...structuredClone(target),
      revision: newRevision,
      sequence: (await this.repository.latestSequence()) + 1,
      createdAt: new Date().toISOString(),
      rolledBackFrom: active.revision,
    };
    return this.publish(rollback, expectedActiveRevision);
  }

  async resolve(appVersion: string, knownRevision?: string): Promise<{
    notModified: boolean;
    compatible: boolean;
    config?: RemoteConfigRevision;
  }> {
    if (!/^v?\d+(?:\.\d+){0,3}$/.test(appVersion)) throw new BadRequestException('Invalid appVersion');
    const active = await this.current();
    const compatible = !active.minAppVersion || compareVersions(appVersion, active.minAppVersion) >= 0;
    return {
      notModified: compatible && knownRevision === active.revision,
      compatible,
      config: compatible && knownRevision !== active.revision ? active : undefined,
    };
  }

  async current(): Promise<RemoteConfigRevision> {
    const active = await this.repository.active();
    if (!active) throw new NotFoundException('No active remote config');
    return active;
  }
}

function validateConfig(config: RemoteConfigRevision): void {
  if (!config.revision.trim() || !Number.isSafeInteger(config.sequence) || config.sequence < 1) throw new BadRequestException('Invalid config revision');
  if (!Number.isFinite(Date.parse(config.createdAt))) throw new BadRequestException('Invalid config timestamp');
  if (!config.values || !config.killSwitches || !config.values.tutorialCopy) throw new BadRequestException('Config values and kill switches are required');
  if (!Number.isFinite(config.values.difficultyMultiplier) || config.values.difficultyMultiplier < 0.5 || config.values.difficultyMultiplier > 2) {
    throw new BadRequestException('difficultyMultiplier is outside guardrails');
  }
  if (!Number.isSafeInteger(config.values.offerDelaySeconds) || config.values.offerDelaySeconds < 0 || config.values.offerDelaySeconds > 86_400) {
    throw new BadRequestException('offerDelaySeconds is outside guardrails');
  }
  if (config.values.blockedClientRevisions && (!Array.isArray(config.values.blockedClientRevisions) || config.values.blockedClientRevisions.some(value => typeof value !== 'string' || value.length > 64))) {
    throw new BadRequestException('blockedClientRevisions must contain short strings');
  }
  if (Object.values(config.killSwitches).some(value => typeof value !== 'boolean')) throw new BadRequestException('Kill switches must be boolean');
  if (Object.values(config.values.tutorialCopy).some(value => typeof value !== 'string')) throw new BadRequestException('Tutorial copy must be strings');
}

function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/, '').split('.').map(Number);
  const b = right.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
