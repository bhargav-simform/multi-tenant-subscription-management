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

  // §13.8 check #2 / §22.2: refuse to boot with an unsafe database role. A
  // superuser or BYPASSRLS role would void the RLS policies on `audit_events`
  // and `security_events` — and, specific to this service, would also void the
  // "no UPDATE or DELETE granted" append-only guarantee (§8.7), since a
  // superuser ignores table grants outright.
  await assertRlsSafeRole(app.get<DataSource>(getDataSourceToken()));

  app.useLogger(app.get(Logger));
  app.use(helmet());

  // §25.1: whitelist + forbidNonWhitelisted rejects a smuggled organizationId
  // in any request rather than silently stripping it (§13.7 row 6).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = config.get<string>('PORT', '3006');
  await app.listen(port);
}

void bootstrap();
