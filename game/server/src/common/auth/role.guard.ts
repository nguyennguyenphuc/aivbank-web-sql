import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlayerRole } from '../../modules/auth/auth.types.js';
import type { AuthenticatedRequest } from './request-auth.js';

export const REQUIRED_ROLES = 'required_roles';
export const RequireRoles = (...roles: PlayerRole[]): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_ROLES, roles);

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PlayerRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]) ?? [];
    if (required.length === 0) return true;
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().auth;
    if (!principal || !required.some(role => principal.roles.includes(role))) throw new ForbiddenException('Insufficient role');
    return true;
  }
}
