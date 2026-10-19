import { ParseResult, asInteger, asNonEmptyString, asRecord, coerceParseResult, fail, ok, pickValue } from './validation';
import { CURRENT_CONTRACT_REVISION } from './revision-id';

export const IDEMPOTENCY_HEADER_KEYS = ['idempotency-key', 'idempotency-scope', 'x-request-id'] as const;
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'precondition_failed'
  | 'unprocessable_entity'
  | 'internal_error';

export interface IdempotencyHeaders {
  idempotency_key: string;
  idempotency_scope?: string;
  request_id?: string;
}

export interface PaginationQuery {
  cursor?: string;
  limit?: number;
}

export interface PageEnvelope<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ApiSuccessEnvelope<T> {
  ok: true;
  data: T;
  meta?: {
    request_id?: string;
    revision_id: string;
  };
}

export interface ApiErrorEnvelope {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    request_id?: string;
    details?: Record<string, unknown>;
    retry_after_seconds?: number;
    revision_id: string;
  };
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export function parseIdempotencyHeaders(value: unknown): ParseResult<IdempotencyHeaders> {
  const parsed = asRecord(value, 'headers');
  if (!parsed.ok) return coerceParseResult(parsed);

  const key = pickValue(parsed.value, 'idempotency-key', asNonEmptyString);
  if (!key.ok) return coerceParseResult(key);

  const scope = pickOptionalString(parsed.value, 'idempotency-scope');
  if (!scope.ok) return coerceParseResult(scope);
  const requestId = pickOptionalString(parsed.value, 'x-request-id');
  if (!requestId.ok) return coerceParseResult(requestId);

  return ok({
    idempotency_key: key.value,
    idempotency_scope: scope.value,
    request_id: requestId.value,
  });
}

export function parsePaginationQuery(value: unknown): ParseResult<PaginationQuery> {
  const parsed = asRecord(value, 'query');
  if (!parsed.ok) return coerceParseResult(parsed);

  const cursor = pickOptionalString(parsed.value, 'cursor');
  if (!cursor.ok) return coerceParseResult(cursor);

  const limitValue = parsed.value.limit;
  if (limitValue === undefined || limitValue === null || limitValue === '') {
    return ok({ cursor: cursor.value, limit: DEFAULT_PAGE_LIMIT });
  }

  const limit = typeof limitValue === 'string' ? Number(limitValue) : limitValue;
  const parsedLimit = asInteger(limit, 'limit', 1, MAX_PAGE_LIMIT);
  if (!parsedLimit.ok) return coerceParseResult(parsedLimit);

  return ok({ cursor: cursor.value, limit: parsedLimit.value });
}

export function makePageEnvelope<T>(items: T[], nextCursor: string | null): PageEnvelope<T> {
  return { items, next_cursor: nextCursor, has_more: nextCursor !== null };
}

export function makeSuccessEnvelope<T>(data: T, requestId?: string): ApiSuccessEnvelope<T> {
  return {
    ok: true,
    data,
    meta: {
      request_id: requestId,
      revision_id: CURRENT_CONTRACT_REVISION.value,
    },
  };
}

export function makeErrorEnvelope(
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
  requestId?: string,
  retryAfterSeconds?: number,
): ApiErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      request_id: requestId,
      details,
      retry_after_seconds: retryAfterSeconds,
      revision_id: CURRENT_CONTRACT_REVISION.value,
    },
  };
}

function pickOptionalString(source: Record<string, unknown>, key: string): ParseResult<string | undefined> {
  const value = source[key];
  if (value === undefined || value === null || value === '') return ok(undefined);
  return asNonEmptyString(value, key);
}
