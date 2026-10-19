export type PlayerRole = 'student' | 'instructor' | 'analyst' | 'admin';

export interface AuthAccountRow {
  accountId: string;
  email?: string;
  passwordHash?: string;
  displayName: string;
  guest: boolean;
  roles: PlayerRole[];
  createdAt: string;
}

export interface AuthSessionRow {
  sessionId: string;
  accountId: string;
  deviceId: string;
  refreshTokenHash: string;
  rotation: number;
  expiresAt: number;
  revokedAt?: number;
}

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
