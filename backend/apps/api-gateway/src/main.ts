import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';

/**
 * §10: the only service published to the host. The other six bind to the internal
 * Docker network only (§10.5 layer 1), which is why this is the one main.ts that
 * configures CORS at all.
 *
 * Note the absence of assertRlsSafeRole() and of any DataSource lookup that every
 * other service's bootstrap performs — there is no database to check (§10.3).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(ConfigService);

  app.useLogger(app.get(Logger));

  // §10.2/§25.1: security headers on the one surface an attacker can actually reach.
  app.use(helmet());

  /**
   * §10.2: CORS allowlist from CORS_ORIGINS, comma-separated. An allowlist, never
   * `origin: true` — reflecting an arbitrary origin with credentials: true is the
   * standard way this control is accidentally disabled.
   *
   * getOrThrow, not a fallback: a fallback here would default to a frontend DEV
   * origin baked into gateway code, silently narrowing the allowlist to
   * localhost in any environment that forgot to set this — a misconfiguration
   * that should fail loudly at boot, not degrade quietly.
   */
  const origins = config
    .getOrThrow<string>('CORS_ORIGINS')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // §10.2 "Coarse request validation" — reject a malformed or oversized payload
  // before it costs a downstream hop. Deliberately NOT a re-declaration of any
  // downstream DTO (§10.3): the gateway's routes take unknown bodies and forward
  // them, and each downstream service's own ValidationPipe is the single place the
  // rules for its own input live. Two copies of a validation rule is two copies that
  // drift.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // §8.1/§10.2: the entire public API surface lives under one versioned prefix.
  app.setGlobalPrefix('api/v1');

  // PORT is deliberately not in .env — it's set per-service in
  // docker-compose.yml's `environment:` block (root README's "Root-level
  // commands" note). A local, non-Docker run exports it explicitly.
  const port = config.getOrThrow<string>('PORT');
  await app.listen(port);
}

void bootstrap();
