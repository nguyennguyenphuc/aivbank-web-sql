import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { toErrorEnvelope } from '../../server/src/common/error-envelope.js';

describe('error envelope', () => {
  it('preserves safe HTTP messages', () => {
    expect(toErrorEnvelope(new BadRequestException('Invalid input'), 'request-1')).toMatchObject({
      error: { code: 'Bad Request', message: 'Invalid input', requestId: 'request-1' },
    });
  });

  it('does not disclose internal exception details', () => {
    const envelope = toErrorEnvelope(new Error('password authentication failed for postgres://secret'), 'request-2');
    expect(envelope).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred', requestId: 'request-2' },
    });
  });
});
