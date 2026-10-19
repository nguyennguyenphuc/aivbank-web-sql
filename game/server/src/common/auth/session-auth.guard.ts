import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthService } from '../../modules/auth/auth.service.js';
import type { AuthenticatedRequest } from './request-auth.js';
import { readCookie } from './request-auth.js';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : readCookie(request.headers.cookie, 'session');
    if (!token) throw new UnauthorizedException('Session token is required');
    (request as AuthenticatedRequest).auth = await this.authService.authenticate(token);
    return true;
  }
}
