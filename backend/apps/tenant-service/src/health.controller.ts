import { Controller, Get } from '@nestjs/common';
import { Public } from '@app/tenant-context';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** §26.4: liveness + readiness. Compose uses these for startup ordering. */
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async readiness(): Promise<{ status: string; database: boolean }> {
    const database = await this.dataSource
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);
    return { status: database ? 'ok' : 'degraded', database };
  }
}
