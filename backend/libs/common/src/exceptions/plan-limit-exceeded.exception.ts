import { ConflictException } from '@nestjs/common';

export interface PlanLimitExceededDetails {
  limitType: 'seats' | 'storage';
  limit: number;
  current: number;
  planCode: string;
  activeUsers?: number;
  pendingInvitations?: number;
}

/**
 * The §19.5 rejection shape. Message must be specific and actionable — R6 explicitly
 * forbids a generic error. correlationId is attached by the exception filter, not here.
 */
export class PlanLimitExceededException extends ConflictException {
  constructor(details: PlanLimitExceededDetails, message: string) {
    super({
      statusCode: 409,
      error: 'PLAN_LIMIT_EXCEEDED',
      message,
      details,
    });
  }
}
