import 'reflect-metadata';
import { loadEnv } from './config/env.js';
import { createApp } from './create-app.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen({ host: env.HOST, port: env.PORT });
}

void bootstrap();
