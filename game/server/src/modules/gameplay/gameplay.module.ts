import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GameplayController } from './gameplay.controller.js';
import { GameplayService } from './gameplay.service.js';
import { ReplayValidatorService } from './replay-validator.service.js';
import { GAMEPLAY_RUN_SECRET, RunTokenService } from './run-token.service.js';
import { CompetitionModule } from '../competition/competition.module.js';
import { LiveOpsModule } from '../liveops/liveops.module.js';
import { PlayerModule } from '../player/player.module.js';
import { EconomyModule } from '../economy/economy.module.js';

@Module({
  imports: [AuthModule, ContentModule, PlayerModule, CompetitionModule, LiveOpsModule, EconomyModule],
  controllers: [GameplayController],
  providers: [
    {
      provide: GAMEPLAY_RUN_SECRET,
      useFactory: () => {
        const secret = process.env.SESSION_SECRET;
        if (process.env.NODE_ENV === 'production' && !secret) throw new Error('SESSION_SECRET is required for gameplay run tokens');
        return secret ?? 'local-gameplay-run-secret';
      },
    },
    RunTokenService,
    ReplayValidatorService,
    GameplayService,
  ],
  exports: [GameplayService, ReplayValidatorService],
})
export class GameplayModule {}
