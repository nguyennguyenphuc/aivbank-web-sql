import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  InboxMessage, LiveOpsCalendar, PlayerQuestState,
} from '../../../../shared/contracts/liveops/index.js';

export interface LiveOpsRepository {
  publishCalendar(calendar: LiveOpsCalendar): Promise<void>;
  activateCalendar(revision: string, expectedRevision?: string): Promise<void>;
  activeCalendar(): Promise<LiveOpsCalendar | undefined>;
  incrementQuest(playerId: string, questId: string, amount: number, target: number): Promise<PlayerQuestState>;
  applyProgressEvent(playerId: string, eventId: string, updates: Array<{ questId: string; amount: number; target: number }>): Promise<boolean>;
  questState(playerId: string, questId: string, target: number): Promise<PlayerQuestState>;
  claimQuest(playerId: string, questId: string, target: number): Promise<PlayerQuestState>;
  publishInbox(message: InboxMessage): Promise<void>;
  inbox(playerId: string): Promise<Array<InboxMessage & { claimed: boolean }>>;
  claimInbox(playerId: string, messageId: string): Promise<void>;
  lastSeen(playerId: string): Promise<string | undefined>;
  setLastSeen(playerId: string, at: string): Promise<void>;
}

export const LIVEOPS_REPOSITORY = Symbol('LIVEOPS_REPOSITORY');

@Injectable()
export class InMemoryLiveOpsRepository implements LiveOpsRepository {
  private readonly calendars = new Map<string, LiveOpsCalendar>();
  private readonly progress = new Map<string, number>();
  private readonly questClaims = new Set<string>();
  private readonly messages = new Map<string, InboxMessage>();
  private readonly inboxClaims = new Set<string>();
  private readonly seen = new Map<string, string>();
  private readonly progressEvents = new Set<string>();
  private activeRevision?: string;

  async publishCalendar(calendar: LiveOpsCalendar): Promise<void> {
    const existing = this.calendars.get(calendar.revision);
    if (existing && JSON.stringify(existing) !== JSON.stringify(calendar)) throw new ConflictException('Calendar revisions are immutable');
    this.calendars.set(calendar.revision, structuredClone(calendar));
  }

  async activateCalendar(revision: string, expectedRevision?: string): Promise<void> {
    if (!this.calendars.has(revision)) throw new NotFoundException('Calendar revision not found');
    if (expectedRevision !== undefined && this.activeRevision !== expectedRevision) throw new ConflictException('Active calendar changed');
    this.activeRevision = revision;
  }

  async activeCalendar(): Promise<LiveOpsCalendar | undefined> {
    const calendar = this.activeRevision ? this.calendars.get(this.activeRevision) : undefined;
    return calendar ? structuredClone(calendar) : undefined;
  }

  async incrementQuest(playerId: string, questId: string, amount: number, target: number): Promise<PlayerQuestState> {
    const key = `${playerId}:${questId}`;
    this.progress.set(key, Math.min(target, (this.progress.get(key) ?? 0) + amount));
    return this.questState(playerId, questId, target);
  }

  async applyProgressEvent(playerId: string, eventId: string, updates: Array<{ questId: string; amount: number; target: number }>): Promise<boolean> {
    const eventKey = `${playerId}:${eventId}`;
    if (this.progressEvents.has(eventKey)) return false;
    this.progressEvents.add(eventKey);
    for (const update of updates) await this.incrementQuest(playerId, update.questId, update.amount, update.target);
    return true;
  }

  async questState(playerId: string, questId: string, target: number): Promise<PlayerQuestState> {
    const key = `${playerId}:${questId}`;
    const progress = this.progress.get(key) ?? 0;
    const claimed = this.questClaims.has(key);
    return { questId, progress, target, claimable: progress >= target && !claimed, claimed };
  }

  async claimQuest(playerId: string, questId: string, target: number): Promise<PlayerQuestState> {
    const state = await this.questState(playerId, questId, target);
    if (state.claimed) throw new ConflictException('Quest reward already claimed');
    if (!state.claimable) throw new ConflictException('Quest is incomplete');
    this.questClaims.add(`${playerId}:${questId}`);
    return { ...state, claimable: false, claimed: true };
  }

  async publishInbox(message: InboxMessage): Promise<void> {
    const existing = this.messages.get(message.messageId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(message)) throw new ConflictException('Inbox messages are immutable');
    this.messages.set(message.messageId, structuredClone(message));
  }

  async inbox(playerId: string): Promise<Array<InboxMessage & { claimed: boolean }>> {
    return [...this.messages.values()]
      .filter(message => !message.accountId || message.accountId === playerId)
      .map(message => ({ ...structuredClone(message), claimed: this.inboxClaims.has(`${playerId}:${message.messageId}`) }));
  }

  async claimInbox(playerId: string, messageId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message || (message.accountId && message.accountId !== playerId)) throw new NotFoundException('Inbox message not found');
    const key = `${playerId}:${messageId}`;
    if (this.inboxClaims.has(key)) throw new ConflictException('Inbox reward already claimed');
    this.inboxClaims.add(key);
  }

  async lastSeen(playerId: string): Promise<string | undefined> { return this.seen.get(playerId); }
  async setLastSeen(playerId: string, at: string): Promise<void> { this.seen.set(playerId, at); }
}
