import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtAccessPayload } from '../jwt-payload.type';

/** @CurrentUser() in an api-gateway controller — the verified JWT payload. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtAccessPayload => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return req.user as JwtAccessPayload;
  },
);
