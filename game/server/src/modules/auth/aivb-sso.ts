import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

/**
 * Vé SSO do AIV Bank cấp (`backend/game_bridge.py::sign_ticket`).
 *
 * Dạng: `base64url(JSON claims).base64url(HMAC-SHA256(secret, phần đầu))`.
 * Vé sống tối đa 60 giây và chỉ dùng được một lần (xem `consumeSsoTicket`).
 */
export interface AivbTicketClaims {
  iss: 'aivb';
  sub: string;
  name: string;
  role: 'student' | 'instructor';
  iat: number;
  exp: number;
  jti: string;
}

export const AIVB_TICKET_MAX_TTL_S = 60;

export function signAivbTicket(claims: AivbTicketClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyAivbTicket(ticket: string, secret: string, nowMs = Date.now()): AivbTicketClaims {
  const [body, signature, extra] = ticket.split('.');
  if (!body || !signature || extra !== undefined) throw new UnauthorizedException('Invalid SSO ticket');
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new UnauthorizedException('Invalid SSO ticket');
  }
  let claims: AivbTicketClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AivbTicketClaims;
  } catch {
    throw new UnauthorizedException('Invalid SSO ticket');
  }
  const now = Math.floor(nowMs / 1000);
  const valid = claims.iss === 'aivb'
    && typeof claims.sub === 'string' && /^[A-Za-z0-9_.-]{1,63}$/.test(claims.sub)
    && typeof claims.name === 'string'
    && (claims.role === 'student' || claims.role === 'instructor')
    && typeof claims.jti === 'string' && claims.jti.length >= 16
    && Number.isInteger(claims.iat) && Number.isInteger(claims.exp)
    && claims.exp > now
    && claims.iat <= now + 5
    && claims.exp - claims.iat <= AIVB_TICKET_MAX_TTL_S;
  if (!valid) throw new UnauthorizedException('Invalid or expired SSO ticket');
  return claims;
}
