import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as not requiring internal context / JWT.
 * Exactly three routes in the whole system carry this (§11.5):
 *   /onboarding/signup · /auth/login · /invitations/:token/accept
 * A fourth requires the same explicit justification given to those three.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
