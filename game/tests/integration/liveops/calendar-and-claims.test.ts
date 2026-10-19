import { describe, expect, it } from 'vitest';
import type { LiveOpsCalendar } from '../../../shared/contracts/liveops/index.js';
import { InMemoryLiveOpsRepository } from '../../../server/src/modules/liveops/liveops.repository.js';
import { LiveOpsService } from '../../../server/src/modules/liveops/liveops.service.js';

const calendar: LiveOpsCalendar = {
  revision: 'calendar.1', publishedAt: '2026-08-01T00:00:00Z',
  events: [{ eventId: 'summer', title: 'Summer', bannerKey: 'summer', startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-09-01T00:00:00Z' }],
  quests: [
    { questId: 'daily-win', cadence: 'daily', title: 'Win', metric: 'level_won', target: 2, reward: { rewardId: 'daily', soft: 20 }, startsAt: '2026-08-28T00:00:00Z', endsAt: '2026-08-29T00:00:00Z' },
    { questId: 'weekly-win', cadence: 'weekly', title: 'Weekly', metric: 'level_won', target: 5, reward: { rewardId: 'weekly', soft: 100 }, startsAt: '2026-08-24T00:00:00Z', endsAt: '2026-08-31T00:00:00Z' },
    { questId: 'season-win', cadence: 'season', title: 'Season', metric: 'level_won', target: 20, reward: { rewardId: 'season', hard: 2 }, startsAt: '2026-08-01T00:00:00Z', endsAt: '2026-09-01T00:00:00Z' },
    { questId: 'achievement-win', cadence: 'achievement', title: 'Champion', metric: 'level_won', target: 100, reward: { rewardId: 'achievement', itemId: 'crown', quantity: 1 }, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z' },
    { questId: 'comeback-win', cadence: 'comeback', title: 'Welcome back', metric: 'level_won', target: 1, reward: { rewardId: 'comeback', soft: 50 }, startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z' },
  ],
};

describe('live-ops calendar and claims', () => {
  const economy = { grant: async () => ({ accountId: 'p1', soft: 20, hard: 0, inventory: {}, revision: 1 }) };
  it('progresses every active cadence from verified events and makes claims one-time', async () => {
    const service = new LiveOpsService(new InMemoryLiveOpsRepository(), economy as never);
    await service.publishCalendar(calendar);
    await service.recordVerifiedProgress('p1', 'event-1', 'level_won', 2, '2026-08-28T12:00:00Z', 'server-event');
    await service.recordVerifiedProgress('p1', 'event-1', 'level_won', 2, '2026-08-28T12:00:00Z', 'server-event');
    const hub = await service.hub('p1', '2026-08-28T12:00:00Z');
    expect(hub.quests.map(quest => quest.questId)).toEqual(['daily-win', 'weekly-win', 'season-win', 'achievement-win']);
    expect(hub.quests[0].claimable).toBe(true);
    expect(await service.claimQuest('p1', 'daily-win', '2026-08-28T12:00:00Z')).toMatchObject({ rewardId: 'daily', soft: 20 });
    await expect(service.claimQuest('p1', 'daily-win', '2026-08-28T12:00:00Z')).resolves.toMatchObject({ rewardId: 'daily' });
  });

  it('isolates targeted inbox messages and detects comeback eligibility', async () => {
    const service = new LiveOpsService(new InMemoryLiveOpsRepository(), economy as never);
    await service.publishCalendar(calendar);
    await service.publishInbox({
      messageId: 'gift-p1', accountId: 'p1', subject: 'Gift', body: 'Welcome back', reward: { rewardId: 'gift', soft: 10 },
      availableAt: '2026-08-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z',
    });
    await service.markSeen('p1', '2026-08-01T00:00:00Z');
    const returningHub = await service.hub('p1', '2026-08-28T12:00:00Z');
    expect(returningHub.comebackEligible).toBe(true);
    expect(returningHub.quests.some(quest => quest.questId === 'comeback-win')).toBe(true);
    expect((await service.hub('p2', '2026-08-28T12:00:00Z')).inbox).toEqual([]);
    expect(await service.claimInbox('p1', 'gift-p1', '2026-08-28T12:00:00Z')).toMatchObject({ rewardId: 'gift' });
  });
});
