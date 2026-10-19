import type { LiveOpsHub } from '../../../shared/contracts/liveops';
import { apiFetch } from '../auth/api-client';

export async function loadLiveOpsHub(signal?: AbortSignal): Promise<LiveOpsHub> {
  return apiFetch<LiveOpsHub>('/api/v1/liveops/hub', { signal });
}

export async function claimQuest(questId: string): Promise<void> {
  await apiFetch(`/api/v1/liveops/quests/${encodeURIComponent(questId)}/claim`, { method: 'POST' });
}
