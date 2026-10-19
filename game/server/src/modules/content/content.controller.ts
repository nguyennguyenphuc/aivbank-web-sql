import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ContentService } from './content.service.js';

@Controller('/content')
export class ContentController {
  constructor(@Inject(ContentService) private readonly content: ContentService) {}

  @Get('/revisions/:revision')
  revision(@Param('revision') revision: string): unknown {
    return this.content.getRevision(revision);
  }

  @Get('/revisions/:revision/levels/:levelId')
  level(@Param('revision') revision: string, @Param('levelId') levelId: string, @Query('appVersion') appVersion?: string): unknown {
    return this.content.getLevel(revision, Number(levelId), appVersion);
  }

  @Post('/endless/seed')
  endless(@Body() body: { ladderLevel?: number; playerSeed?: number }): unknown {
    return this.content.issueEndlessSeed(Number(body.ladderLevel), Number(body.playerSeed ?? 0));
  }
}
