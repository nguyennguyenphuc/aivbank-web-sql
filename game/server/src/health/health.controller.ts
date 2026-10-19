import { Controller, Get, Inject } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get('/health')
  async healthz(): Promise<{ ok: true }> {
    return this.healthService.liveness();
  }

  @Get('/ready')
  async readyz(): Promise<unknown> {
    return this.healthService.readiness();
  }
}
