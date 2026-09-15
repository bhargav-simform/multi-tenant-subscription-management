import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * §26.4: liveness + readiness. No @Public() (§13.7 row 6) — exempted from
 * InternalContextGuard by an exact hardcoded path check instead. See
 * libs/tenant-context/src/guards/internal-context.guard.ts.
 */
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<{ status: string; database: boolean }> {
    const database = await this.dataSource
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    return { status: database ? 'ok' : 'degraded', database };
  }
}
