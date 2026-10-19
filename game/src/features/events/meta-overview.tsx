import { useEffect, useState } from 'react';
import type { CompetitionMetaState, LeaderboardPage } from '../../../shared/contracts/competition';
import type { LiveOpsHub } from '../../../shared/contracts/liveops';
import { competitionApi } from '../leaderboards/competition-api';
import { LeaderboardPanel } from '../leaderboards/leaderboard-panel';
import { QuestPanel } from '../quests/quest-panel';
import { StreakBadge } from '../streaks/streak-badge';
import { EventBanner } from './event-banner';
import { claimQuest, loadLiveOpsHub } from './liveops-api';

interface MetaView { leaderboard: LeaderboardPage; meta: CompetitionMetaState; liveops: LiveOpsHub }

export function MetaOverview({ language }: { language: 'vi' | 'en' }) {
  const [view, setView] = useState<MetaView>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      competitionApi.globalTop(controller.signal),
      competitionApi.meta(controller.signal),
      loadLiveOpsHub(controller.signal),
    ]).then(([leaderboard, meta, liveops]) => setView({ leaderboard, meta, liveops })).catch(() => undefined);
    return () => controller.abort();
  }, [revision]);

  if (!view) return null;
  return (
    <div className="mt-4 grid w-full max-w-3xl grid-cols-1 gap-2 px-4 sm:grid-cols-2" data-testid="meta-overview">
      <EventBanner event={view.liveops.events[0]} language={language} />
      <StreakBadge meta={view.meta} language={language} />
      <LeaderboardPanel page={view.leaderboard} language={language} />
      <QuestPanel quest={view.liveops.quests[0]} language={language} onClaim={async questId => { await claimQuest(questId); setRevision(value => value + 1); }} />
    </div>
  );
}
