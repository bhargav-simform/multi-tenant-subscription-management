import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { isUUID, validate, type ValidationError } from 'class-validator';
import type { NextFunction, Request, Response } from 'express';
import { BadRequestException } from '../lib/http-errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The validated, transformed query DTO (req.query is read-only in Express 5). */
      validatedQuery?: unknown;
    }
  }
}

/**
 * The same pipeline as Nest's ValidationPipe({ whitelist, forbidNonWhitelisted,
 * transform }): plainToInstance -> validate -> 400 with the flattened constraint
 * messages, e.g. { message: ['email must be an email'], error: 'Bad Request', statusCode: 400 }.
 * DTO classes are the same class-validator classes the services used.
 */
export async function validateDto<T extends object>(
  cls: ClassConstructor<T>,
  value: unknown,
): Promise<T> {
  const instance = plainToInstance(cls, value ?? {});
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    throw new BadRequestException(flatten(errors));
  }
  return instance;
}

function flatten(errors: ValidationError[], parentPath?: string): string[] {
  return errors.flatMap((error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const own = error.constraints
      ? Object.values(error.constraints).map((msg) => (parentPath ? `${parentPath}.${msg}` : msg))
      : [];
    const children = error.children?.length ? flatten(error.children, path) : [];
    return [...own, ...children];
  });
}

export function validateBody<T extends object>(cls: ClassConstructor<T>) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    req.body = await validateDto(cls, req.body);
    next();
  };
}

export function validateQuery<T extends object>(cls: ClassConstructor<T>) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    req.validatedQuery = await validateDto(cls, req.query);
    next();
  };
}

/** Nest's ParseUUIDPipe: 400 'Validation failed (uuid is expected)'. */
export function parseUuidParam(name: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!isUUID(req.params[name])) {
      throw new BadRequestException('Validation failed (uuid is expected)');
    }
    next();
  };
}
