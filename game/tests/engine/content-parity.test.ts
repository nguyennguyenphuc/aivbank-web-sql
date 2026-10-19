import { describe, expect, it } from 'vitest';
import { APP_LEVEL_VARIANTS, CANONICAL_CAMPAIGN, ENDLESS_RECIPES, issueEndlessSeed } from '../../shared/contracts/content';
import { ContentService } from '../../server/src/modules/content/content.service.js';
import fixture from '../../fixtures/levels/canonical-campaign.fixture.json';
import { LEVELS } from '../../src/data/levels';

describe('campaign and server content parity', () => {
  const service = new ContentService();

  it('publishes exactly 60 unique canonical levels to browser and server', () => {
    const server = service.getRevision(fixture.revision);
    expect(CANONICAL_CAMPAIGN).toHaveLength(fixture.levelCount);
    expect(LEVELS).toHaveLength(fixture.levelCount);
    expect(server.campaign).toEqual(CANONICAL_CAMPAIGN);
    expect(new Set(CANONICAL_CAMPAIGN.map(level => level.levelId)).size).toBe(60);
  });

  it('retains explicit immutable variants for levels 28-30', () => {
    for (const id of [28, 29, 30] as const) {
      expect(Object.keys(APP_LEVEL_VARIANTS[id])).toEqual(fixture.explicitAppVariants[String(id) as '28']);
      expect(service.getLevel('content.v2.1.1', id, 'v2.1.0')).toEqual(APP_LEVEL_VARIANTS[id]['v2.1.0']);
    }
    expect(APP_LEVEL_VARIANTS[30]['v2.1.1'].tutorialMessageKey).toBe(fixture.tutorialMessageHooks['30@v2.1.1']);
  });

  it('issues stable endless difficulty waves and seeds', () => {
    expect(ENDLESS_RECIPES).toHaveLength(fixture.endlessWaveLength);
    expect(service.issueEndlessSeed(21, 77)).toEqual(issueEndlessSeed(21, 77));
    expect(issueEndlessSeed(1).difficulty).toBe('recovery');
    expect(issueEndlessSeed(20).difficulty).toBe('boss');
  });
});
