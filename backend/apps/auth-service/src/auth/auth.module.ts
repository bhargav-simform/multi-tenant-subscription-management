import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CredentialsModule } from '../credentials/credentials.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenIssuerService } from './token-issuer.service';
import { USER_ROLE_CLIENT } from './user-role-client.interface';
import { HttpUserRoleClient } from './clients/http-user-role.client';
import { CredentialsController } from '../credentials/credentials.controller';

@Module({
  imports: [
    CredentialsModule,
    HttpModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController, CredentialsController],
  providers: [
    AuthService,
    TokenIssuerService,
    { provide: USER_ROLE_CLIENT, useClass: HttpUserRoleClient },
  ],
})
export class AuthModule {}
