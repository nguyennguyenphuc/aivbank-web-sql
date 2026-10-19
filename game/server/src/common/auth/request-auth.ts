import type { FastifyRequest } from 'fastify';
import type { SessionPrincipal } from '../../modules/auth/auth.types.js';

export type AuthenticatedRequest = FastifyRequest & { auth: SessionPrincipal };

export function readCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
