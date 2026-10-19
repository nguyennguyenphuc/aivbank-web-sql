export interface TelemetryIngestEvent {
  eventId: string;
  eventName: string;
  schemaVersion: number;
  occurredAt: string;
  payload: Record<string, unknown>;
  source: 'h5' | 'server' | 'import';
}

export interface TeachingAnalyticsSnapshot {
  dataset: { version: string; synthetic: boolean; totalRows: number; importedAt: string } | null;
  tutorialStep4: Array<{ appVersion: string; platform: string; region: string; completionRate: number; rows: number }>;
  levelFriction: Array<{ appVersion: string; platform: string; region: string; winRate: number; nonCompleteRate: number; attempts: number }>;
  dailyKpi: Array<{ date: string; dau: number; sessions: number; arpdau: number }>;
}
