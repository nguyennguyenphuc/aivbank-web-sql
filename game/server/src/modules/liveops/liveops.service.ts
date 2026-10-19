import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  InboxMessage, LiveOpsCalendar, LiveOpsHub, LiveOpsReward, QuestDefinition,
} from '../../../../shared/contracts/liveops/index.js';
import { LIVEOPS_REPOSITORY, type LiveOpsRepository } from './liveops.repository.js';
import { EconomyService } from '../economy/economy.service.js';
import type { RewardGrant } from '../economy/economy.types.js';

const COMEBACK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class LiveOpsService {
  constructor(
    @Inject(LIVEOPS_REPOSITORY) private readonly repository: LiveOpsRepository,
    @Inject(EconomyService) private readonly economy: EconomyService,
  ) {}

  async publishCalendar(calendar: LiveOpsCalendar, expectedActiveRevision?: string): Promise<void> {
    validateCalendar(calendar);
    await this.repository.publishCalendar(calendar);
    await this.repository.activateCalendar(calendar.revision, expectedActiveRevision);
  }

  async hub(playerId: string, at = new Date().toISOString()): Promise<LiveOpsHub> {
    const now = parseDate(at, 'at');
    const calendar = await this.requireCalendar();
    const lastSeen = await this.repository.lastSeen(playerId);
    const comebackEligible = Boolean(lastSeen && now - Date.parse(lastSeen) >= COMEBACK_AFTER_MS);
    const quests = await Promise.all(calendar.quests.filter(quest => isActive(quest, now) && (quest.cadence !== 'comeback' || comebackEligible))
      .map(quest => this.repository.questState(playerId, quest.questId, quest.target)));
    const inbox = (await this.repository.inbox(playerId))
      .filter(message => Date.parse(message.availableAt) <= now && Date.parse(message.expiresAt) > now);
    return {
      calendarRevision: calendar.revision,
      events: calendar.events.filter(event => isActive(event, now)),
      quests,
      inbox,
      comebackEligible,
    };
  }

  async recordVerifiedProgress(
    playerId: string,
    eventId: string,
    metric: string,
    amount: number,
    at: string,
    verification: 'server-event',
  ): Promise<void> {
    if (verification !== 'server-event' || !eventId.trim() || !Number.isSafeInteger(amount) || amount < 1) {
      throw new BadRequestException('Progress must come from a verified server event');
    }
    const now = parseDate(at, 'at');
    const calendar = await this.requireCalendar();
    const updates = calendar.quests
      .filter(quest => quest.metric === metric && isActive(quest, now))
      .map(quest => ({ questId: quest.questId, amount, target: quest.target }));
    await this.repository.applyProgressEvent(playerId, eventId, updates);
  }

  async claimQuest(playerId: string, questId: string, at = new Date().toISOString()): Promise<LiveOpsReward> {
    const quest = await this.findActiveQuest(questId, parseDate(at, 'at'));
    const state = await this.repository.questState(playerId, quest.questId, quest.target);
    if (!state.claimable && !state.claimed) throw new BadRequestException('Quest is incomplete');
    await this.grantReward(playerId, quest.reward, `quest:${quest.questId}`);
    if (!state.claimed) await this.repository.claimQuest(playerId, quest.questId, quest.target);
    return structuredClone(quest.reward);
  }

  async publishInbox(message: InboxMessage): Promise<void> {
    if (!message.messageId.trim() || Date.parse(message.availableAt) >= Date.parse(message.expiresAt)) {
      throw new BadRequestException('Invalid inbox message');
    }
    await this.repository.publishInbox(message);
  }

  async claimInbox(playerId: string, messageId: string, at = new Date().toISOString()): Promise<LiveOpsReward | undefined> {
    const now = parseDate(at, 'at');
    const message = (await this.repository.inbox(playerId)).find(candidate => candidate.messageId === messageId);
    if (!message || Date.parse(message.availableAt) > now || Date.parse(message.expiresAt) <= now) {
      throw new NotFoundException('Active inbox message not found');
    }
    if (message.reward) await this.grantReward(playerId, message.reward, `inbox:${messageId}`);
    if (!message.claimed) await this.repository.claimInbox(playerId, messageId);
    return message.reward ? structuredClone(message.reward) : undefined;
  }

  async markSeen(playerId: string, at = new Date().toISOString()): Promise<void> {
    parseDate(at, 'at');
    await this.repository.setLastSeen(playerId, at);
  }

  private async findActiveQuest(questId: string, at: number): Promise<QuestDefinition> {
    const quest = (await this.requireCalendar()).quests.find(candidate => candidate.questId === questId && isActive(candidate, at));
    if (!quest) throw new NotFoundException('Active quest not found');
    return quest;
  }

  private async requireCalendar(): Promise<LiveOpsCalendar> {
    const calendar = await this.repository.activeCalendar();
    if (!calendar) throw new NotFoundException('No active live-ops calendar');
    return calendar;
  }

  private async grantReward(playerId: string, reward: LiveOpsReward, referenceId: string): Promise<void> {
    const grants: RewardGrant[] = [];
    if (reward.soft) grants.push({ currency: 'soft', amount: reward.soft });
    if (reward.hard) grants.push({ currency: 'hard', amount: reward.hard });
    if (reward.itemId && reward.quantity) grants.push({ itemId: reward.itemId, quantity: reward.quantity });
    await this.economy.grant(playerId, grants, 'liveops_reward', referenceId, `liveops:${playerId}:${referenceId}`, `liveops:${playerId}:${referenceId}`);
  }
}

function validateCalendar(calendar: LiveOpsCalendar): void {
  if (!calendar.revision.trim() || !Number.isFinite(Date.parse(calendar.publishedAt))) throw new BadRequestException('Invalid calendar revision');
  const ids = new Set<string>();
  for (const item of [...calendar.events, ...calendar.quests]) {
    const id = 'eventId' in item ? item.eventId : item.questId;
    if (!id.trim() || ids.has(id) || Date.parse(item.startsAt) >= Date.parse(item.endsAt)) throw new BadRequestException('Invalid calendar item');
    ids.add(id);
  }
  for (const quest of calendar.quests) if (!Number.isSafeInteger(quest.target) || quest.target < 1) throw new BadRequestException('Invalid quest target');
}

function isActive(item: { startsAt: string; endsAt: string }, at: number): boolean {
  return Date.parse(item.startsAt) <= at && Date.parse(item.endsAt) > at;
}

function parseDate(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new BadRequestException(`${name} must be an ISO date`);
  return parsed;
}
