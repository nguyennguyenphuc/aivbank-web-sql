export interface KillSwitches {
  content: boolean;
  economy: boolean;
  tutorial: boolean;
  offers: boolean;
  experiments: boolean;
}

export interface RemoteConfigValues {
  tutorialCopy: Record<string, string>;
  difficultyMultiplier: number;
  offerDelaySeconds: number;
  blockedClientRevisions?: string[];
}

export interface RemoteConfigRevision {
  revision: string;
  sequence: number;
  createdAt: string;
  values: RemoteConfigValues;
  killSwitches: KillSwitches;
  minAppVersion?: string;
  rolledBackFrom?: string;
}

export interface ExperimentVariant {
  key: string;
  weightBps: number;
  payload: Record<string, string | number | boolean>;
}

export interface ExperimentDefinition {
  experimentId: string;
  revision: string;
  salt: string;
  enabled: boolean;
  rolloutBps: number;
  variants: ExperimentVariant[];
  countryCodes?: string[];
}

export interface ExperimentAssignment {
  experimentId: string;
  revision: string;
  variant: string;
  payload: Record<string, string | number | boolean>;
  eligible: boolean;
}
