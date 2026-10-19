import { describe, expect, it } from 'vitest';
import { ExportsService } from '../../server/src/modules/exports/exports.service.js';

describe('compatibility export status', () => {
  it('reports all 13 Jelly Trail tables and reconciles the total', async () => {
    const database = { query: async () => [{ count: '2' }] };
    const status = await new ExportsService(database as never).status();
    expect(status.tables).toHaveLength(13);
    expect(status.totalRows).toBe(26);
  });
});
