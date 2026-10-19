import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { parseOrigins, type AppEnv } from '../../config/env.js';
import { APP_ENV } from '../../database/database.service.js';
import { readCookie } from './request-auth.js';

@Injectable()
export class OriginCsrfGuard implements CanActivate {
  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const origin = request.headers.origin;
    try {
      if (!isAllowedOrigin(this.env, origin)) throw new Error('origin mismatch');
    } catch {
      throw new ForbiddenException('Origin is not allowed');
    }
    const cookie = readCookie(request.headers.cookie, 'csrf');
    const header = request.headers['x-csrf-token'];
    if (!cookie || typeof header !== 'string' || cookie !== header) throw new ForbiddenException('CSRF token mismatch');
    return true;
  }
}

export function isAllowedOrigin(env: AppEnv, origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return (parseOrigins(env.WEB_ORIGIN) ?? []).includes(new URL(origin).origin);
  } catch {
    return false;
  }
}
