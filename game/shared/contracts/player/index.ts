export interface PlayerSettings {
  sound: boolean;
  music: boolean;
  reducedMotion: boolean;
  locale: string;
}

export interface PlayerProgress {
  unlockedLevel: number;
  starsEarned: number;
  totalScore: number;
  lastLevelId: number;
  revision: number;
}

export interface PlayerSnapshot {
  accountId: string;
  displayName: string;
  settings: PlayerSettings;
  progress: PlayerProgress;
  updatedAt: string;
}

export interface PracticeResult {
  operationId: string;
  levelId: number;
  score: number;
  stars: number;
  ranked: false;
}
