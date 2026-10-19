import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { GlobalErrorFilter } from './common/global-error.filter.js';
import type { AppEnv } from './config/env.js';

export async function createApp(env: AppEnv): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger: env.LOG_LEVEL === 'silent' ? false : { level: env.LOG_LEVEL },
    genReqId: (request: { headers: Record<string, string | string[] | undefined> }) => {
      const headerId = request.headers['x-request-id'];
      return typeof headerId === 'string' && headerId.length > 0
        ? headerId
        : `req_${crypto.randomUUID()}`;
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('cache-control', 'no-store');
    if (env.NODE_ENV === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    fastify.log.info({
      requestId: request.id,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
    }, 'request complete');
    done();
  });

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new GlobalErrorFilter());
  app.enableShutdownHooks();
  await app.init();
  return app;
}
