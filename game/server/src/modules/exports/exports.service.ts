import { Inject, Injectable } from '@nestjs/common';
import type { CompatibilityStatus } from '../../../../shared/contracts/exports/index.js';
import { DatabaseService } from '../../database/database.service.js';

const TABLES = ['users', 'tutorial_steps', 'sessions', 'player_daily', 'level_metadata', 'level_attempts', 'booster_events', 'purchases', 'ad_events', 'campaign_spend', 'liveops_events', 'ab_assignments', 'daily_kpi'] as const;

@Injectable()
export class ExportsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async status(): Promise<CompatibilityStatus> {
    const tables = [];
    for (const table of TABLES) {
      const rows = await this.database.query<{ [key: string]: unknown; count: string }>(`select count(*) count from jelly_analytics.${table}`);
      tables.push({ table, rows: Number(rows[0]?.count ?? 0) });
    }
    return { tables, totalRows: tables.reduce((sum, table) => sum + table.rows, 0) };
  }
}
