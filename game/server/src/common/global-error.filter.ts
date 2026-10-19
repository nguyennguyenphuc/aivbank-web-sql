import { Catch, ExceptionFilter, HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toErrorEnvelope } from './error-envelope.js';

@Catch()
export class GlobalErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
    if (statusCode >= 500) {
      const trace = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`Unhandled request error requestId=${String(request.id)}`, trace);
    }
    response.status(statusCode).send(toErrorEnvelope(exception, String(request.id)));
  }
}
