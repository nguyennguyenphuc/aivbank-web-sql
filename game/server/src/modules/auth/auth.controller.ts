import { Body, Controller, ForbiddenException, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isAllowedOrigin, OriginCsrfGuard } from '../../common/auth/origin-csrf.guard.js';
import { APP_ENV } from '../../database/database.service.js';
import type { AppEnv } from '../../config/env.js';
import type { AuthenticatedRequest } from '../../common/auth/request-auth.js';
import { RoleGuard, RequireRoles } from '../../common/auth/role.guard.js';
import { SessionAuthGuard } from '../../common/auth/session-auth.guard.js';
import { AuthService } from './auth.service.js';
import type { PlayerRole, SessionBundle } from './auth.types.js';

@Controller('/v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  /**
   * Đăng nhập từ AIV Bank. Chưa có cookie csrf ở thời điểm này nên chỉ kiểm
   * Origin; bản thân vé đã có chữ ký, hạn 60 giây và chỉ dùng một lần.
   */
  @Post('/aivb-sso')
  async aivbSso(
    @Req() request: FastifyRequest,
    @Body() body: { ticket?: string; deviceId?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionBundle> {
    if (!isAllowedOrigin(this.env, request.headers.origin)) throw new ForbiddenException('Origin is not allowed');
    const bundle = await this.authService.aivbSso(body.ticket ?? '', body.deviceId ?? '');
    this.setCookies(reply, bundle);
    return bundle;
  }

  @Post('/guest')
  async guest(
    @Body() body: { deviceId?: string; displayName?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionBundle> {
    const bundle = await this.authService.createGuest(body.deviceId ?? '', body.displayName);
    this.setCookies(reply, bundle);
    return bundle;
  }

  @Post('/login')
  async login(
    @Body() body: { email?: string; password?: string; deviceId?: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionBundle> {
    const bundle = await this.authService.login(body.email ?? '', body.password ?? '', body.deviceId ?? '');
    this.setCookies(reply, bundle);
    return bundle;
  }

  @Post('/refresh')
  @UseGuards(OriginCsrfGuard)
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<SessionBundle> {
    const refreshToken = this.cookie(request.headers.cookie, 'refresh');
    const bundle = await this.authService.rotate(refreshToken ?? '');
    this.setCookies(reply, bundle);
    return bundle;
  }

  @Post('/upgrade')
  @UseGuards(SessionAuthGuard, OriginCsrfGuard)
  async upgrade(@Req() request: AuthenticatedRequest, @Body() body: { email?: string; password?: string }): Promise<{ ok: true }> {
    await this.authService.upgrade(request.auth.accountId, body.email ?? '', body.password ?? '');
    return { ok: true };
  }

  @Post('/roles')
  @RequireRoles('admin')
  @UseGuards(SessionAuthGuard, RoleGuard, OriginCsrfGuard)
  async grantRole(@Body() body: { accountId: string; role: PlayerRole }): Promise<{ ok: true }> {
    await this.authService.grantRole(body.accountId, body.role);
    return { ok: true };
  }

  @Get('/me')
  @UseGuards(SessionAuthGuard)
  me(@Req() request: AuthenticatedRequest) {
    return request.auth;
  }

  @Get('/session')
  async session(@Req() request: FastifyRequest): Promise<{ principal: AuthenticatedRequest['auth'] | null }> {
    const token = this.cookie(request.headers.cookie, 'session');
    if (!token) return { principal: null };
    try { return { principal: await this.authService.authenticate(token) }; }
    catch { return { principal: null }; }
  }

  @Post('/logout')
  @UseGuards(SessionAuthGuard, OriginCsrfGuard)
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ ok: true }> {
    await this.authService.revoke(request.auth.sessionId);
    const { root, refresh } = this.cookiePaths();
    reply.header('set-cookie', [
      `session=; Path=${root}; HttpOnly; SameSite=Strict; Max-Age=0`,
      `refresh=; Path=${refresh}; HttpOnly; SameSite=Strict; Max-Age=0`,
      `csrf=; Path=${root}; SameSite=Strict; Max-Age=0`,
    ]);
    return { ok: true };
  }

  private setCookies(reply: FastifyReply, bundle: SessionBundle): void {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    const { root, refresh } = this.cookiePaths();
    reply.header('set-cookie', [
      `session=${bundle.accessToken}; Path=${root}; HttpOnly; SameSite=Strict${secure}`,
      `refresh=${bundle.refreshToken}; Path=${refresh}; HttpOnly; SameSite=Strict${secure}`,
      `csrf=${bundle.csrfToken}; Path=${root}; SameSite=Strict${secure}`,
    ]);
  }

  // Dưới AIV Bank (PUBLIC_BASE_PATH=/game) cookie chỉ gửi cho /game/..., không
  // lẫn vào không gian cookie của ứng dụng chủ.
  private cookiePaths(): { root: string; refresh: string } {
    const base = this.env.PUBLIC_BASE_PATH;
    return { root: base || '/', refresh: `${base}/api/v1/auth/refresh` };
  }

  private cookie(header: string | undefined, name: string): string | undefined {
    return header?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
  }
}
