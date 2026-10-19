export type QuestCadence = 'daily' | 'weekly' | 'season' | 'comeback' | 'achievement';

export interface LiveOpsReward {
  rewardId: string;
  soft?: number;
  hard?: number;
  itemId?: string;
  quantity?: number;
}

export interface QuestDefinition {
  questId: string;
  cadence: QuestCadence;
  title: string;
  metric: string;
  target: number;
  reward: LiveOpsReward;
  startsAt: string;
  endsAt: string;
}

export interface SeasonalEvent {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  bannerKey: string;
}

export interface LiveOpsCalendar {
  revision: string;
  publishedAt: string;
  events: SeasonalEvent[];
  quests: QuestDefinition[];
}

export interface PlayerQuestState {
  questId: string;
  progress: number;
  target: number;
  claimable: boolean;
  claimed: boolean;
}

export interface InboxMessage {
  messageId: string;
  accountId?: string;
  subject: string;
  body: string;
  reward?: LiveOpsReward;
  availableAt: string;
  expiresAt: string;
}

export interface LiveOpsHub {
  calendarRevision: string;
  events: SeasonalEvent[];
  quests: PlayerQuestState[];
  inbox: Array<InboxMessage & { claimed: boolean }>;
  comebackEligible: boolean;
}
