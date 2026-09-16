import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { assertRlsSafeRole } from '@app/database';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(ConfigService);

  // §13.8 check #2 / §22.2: refuse to boot with an unsafe database role. This
  // matters more here than anywhere else in the system — `resources` is the
  // table the cross-tenant proof (§13.1) runs against, and a superuser or
  // BYPASSRLS role would silently void every RLS policy protecting it.
  const dataSource = app.get<DataSource>(getDataSourceToken());
  await assertRlsSafeRole(dataSource);

  app.useLogger(app.get(Logger));
  app.use(helmet());

  // §25.1: whitelist + forbidNonWhitelisted rejects a smuggled organizationId
  // in any request body rather than silently stripping it (§13.7 row 6).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = config.get<string>('PORT', '3005');
  await app.listen(port);
}

void bootstrap();
