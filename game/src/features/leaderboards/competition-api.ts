import type { CompetitionMetaState, LeaderboardPage } from '../../../shared/contracts/competition';
import { apiFetch } from '../auth/api-client';

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(path, { signal });
}

export const competitionApi = {
  globalTop: (signal?: AbortSignal) => readJson<LeaderboardPage>('/api/v1/competition/leaderboards?scope=global&limit=3', signal),
  meta: (signal?: AbortSignal) => readJson<CompetitionMetaState>('/api/v1/competition/meta', signal),
};
