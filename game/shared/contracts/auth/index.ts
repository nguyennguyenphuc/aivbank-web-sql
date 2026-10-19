export const PLAYER_ROLES = ['student', 'instructor', 'analyst', 'admin'] as const;
export type PlayerRole = (typeof PLAYER_ROLES)[number];

export interface SessionPrincipal {
  accountId: string;
  sessionId: string;
  deviceId: string;
  roles: PlayerRole[];
  guest: boolean;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionBundle {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  principal: SessionPrincipal;
}

export interface GuestSessionRequest {
  deviceId: string;
  displayName?: string;
}

export interface UpgradeAccountRequest {
  email: string;
  password: string;
}
