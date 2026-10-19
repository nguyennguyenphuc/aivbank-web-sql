import { Module } from '@nestjs/common';
import { LiveProjectionService } from './live-projection.service.js';

@Module({ providers: [LiveProjectionService], exports: [LiveProjectionService] })
export class LiveProjectionModule {}
