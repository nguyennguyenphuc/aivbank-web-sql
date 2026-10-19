import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  // Một hoặc nhiều origin, cách nhau bằng dấu phẩy (AIV Bank: domain công khai
  // và http://127.0.0.1:8000 khi dùng tại máy).
  WEB_ORIGIN: z.string().default('http://localhost:3000').refine(
    value => parseOrigins(value) !== undefined,
    'must be a comma-separated list of absolute URLs',
  ),
  // Đường dẫn con mà trình duyệt thấy game (ví dụ `/game`); cookie được giới hạn trong đó.
  PUBLIC_BASE_PATH: z.string().regex(/^(\/[A-Za-z0-9_-]+)*$/).default(''),
  // Khoá HMAC chung với AIV Bank để ký vé SSO. Không đặt thì endpoint SSO tắt.
  AIVB_SSO_SECRET: z.string().min(32).optional(),
  APP_NAME: z.string().min(1).default('match3-h5-server'),
  APP_VERSION: z.string().min(1).default('0.1.0'),
  USE_FAKE_INTEGRATIONS: z.coerce.number().int().min(0).max(1).default(0),
  SESSION_SECRET: z.string().min(8).optional(),
  TELEMETRY_HASH_SECRET: z.string().min(8).optional(),
  AUTH_PROVIDER_GOOGLE_CLIENT_ID: z.string().optional(),
  AUTH_PROVIDER_GOOGLE_CLIENT_SECRET: z.string().optional(),
  AUTH_PROVIDER_APPLE_CLIENT_ID: z.string().optional(),
  AUTH_PROVIDER_APPLE_CLIENT_SECRET: z.string().optional(),
}).superRefine((env, context) => {
  if (env.NODE_ENV !== 'production') return;

  for (const key of ['SESSION_SECRET', 'TELEMETRY_HASH_SECRET'] as const) {
    const value = env[key];
    if (!value || Buffer.byteLength(value, 'utf8') < 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'must contain at least 32 bytes in production',
      });
    }
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET === env.TELEMETRY_HASH_SECRET) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TELEMETRY_HASH_SECRET'],
      message: 'must be independent from SESSION_SECRET in production',
    });
  }
  const insecure = (parseOrigins(env.WEB_ORIGIN) ?? []).filter(origin => {
    const url = new URL(origin);
    return url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  });
  if (insecure.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WEB_ORIGIN'],
      message: 'must use https in production',
    });
  }
});

export function parseOrigins(value: string): string[] | undefined {
  const items = value.split(',').map(item => item.trim()).filter(Boolean);
  if (items.length === 0) return undefined;
  try {
    return items.map(item => new URL(item).origin);
  } catch {
    return undefined;
  }
}

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const normalized = {
    ...source,
    HOST: source.HOST ?? source.API_HOST ?? '0.0.0.0',
    PORT: source.PORT ?? source.API_PORT ?? '3001',
  };
  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(issue => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
