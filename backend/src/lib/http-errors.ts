/**
 * HTTP errors that serialise to exactly the bodies NestJS produced, because the
 * frontend parses them (response.data.message / .error / .details):
 *
 *   new NotFoundException()           -> { message: 'Not Found', statusCode: 404 }
 *   new NotFoundException('msg')      -> { message: 'msg', error: 'Not Found', statusCode: 404 }
 *   new ConflictException({ ... })    -> the object, verbatim
 *   new HttpException('msg', 429)     -> { statusCode: 429, message: 'msg' }
 *   anything else thrown              -> { statusCode: 500, message: 'Internal server error' }
 */
export class HttpException extends Error {
  constructor(
    private readonly response: string | Record<string, unknown>,
    public readonly status: number,
  ) {
    super(
      typeof response === 'string'
        ? response
        : typeof response.message === 'string'
          ? response.message
          : 'Http Exception',
    );
    this.name = new.target.name;
  }

  getBody(): Record<string, unknown> {
    if (typeof this.response === 'string') {
      return { statusCode: this.status, message: this.response };
    }
    return this.response;
  }
}

/** Nest's HttpException.createBody() for the named subclasses. */
function createBody(
  objectOrMessage: string | string[] | Record<string, unknown> | undefined,
  description: string,
  statusCode: number,
): Record<string, unknown> {
  if (objectOrMessage === undefined) {
    return { message: description, statusCode };
  }
  if (typeof objectOrMessage === 'object' && !Array.isArray(objectOrMessage)) {
    return objectOrMessage;
  }
  return { message: objectOrMessage, error: description, statusCode };
}

function named(status: number, description: string) {
  return class extends HttpException {
    constructor(objectOrMessage?: string | string[] | Record<string, unknown>) {
      super(createBody(objectOrMessage, description, status), status);
    }
  };
}

export class BadRequestException extends named(400, 'Bad Request') {}
export class UnauthorizedException extends named(401, 'Unauthorized') {}
export class ForbiddenException extends named(403, 'Forbidden') {}
export class NotFoundException extends named(404, 'Not Found') {}
export class ConflictException extends named(409, 'Conflict') {}
export class GoneException extends named(410, 'Gone') {}
export class PayloadTooLargeException extends named(413, 'Payload Too Large') {}
export class InternalServerErrorException extends named(500, 'Internal Server Error') {}
export class ServiceUnavailableException extends named(503, 'Service Unavailable') {}

// ─── Domain exceptions (bodies the frontend matches on by `error`) ───────────

export interface PlanLimitExceededDetails {
  limitType: 'seats' | 'storage';
  limit: number;
  current: number;
  planCode: string;
  activeUsers?: number;
  pendingInvitations?: number;
}

/** The plan-limit rejection. The message must be specific and actionable, never generic. */
export class PlanLimitExceededException extends ConflictException {
  constructor(details: PlanLimitExceededDetails, message: string) {
    super({ statusCode: 409, error: 'PLAN_LIMIT_EXCEEDED', message, details });
  }
}

/** The last org admin cannot be removed or demoted. */
export class LastAdminException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      error: 'LAST_ADMIN_PROTECTED',
      message:
        'This organisation must have at least one admin. Promote another member before removing or demoting this one.',
    });
  }
}
