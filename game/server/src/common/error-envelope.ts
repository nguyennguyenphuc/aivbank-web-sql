import { HttpException } from '@nestjs/common';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export function toErrorEnvelope(error: unknown, requestId: string): ErrorEnvelope {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    if (typeof response === 'string') {
      return {
        error: {
          code: `HTTP_${status}`,
          message: response,
          requestId,
        },
      };
    }

    if (response && typeof response === 'object') {
      const payload = response as Record<string, unknown>;
      return {
        error: {
          code: typeof payload.error === 'string' ? String(payload.error) : `HTTP_${status}`,
          message: typeof payload.message === 'string' ? payload.message : error.message,
          requestId,
          details: payload.details,
        },
      };
    }
  }

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected server error occurred',
      requestId,
    },
  };
}
