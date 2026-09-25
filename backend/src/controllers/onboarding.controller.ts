import type { Request, Response } from 'express';
import type { SignupDto } from '../dtos/onboarding.dto';
import * as onboardingService from '../services/onboarding.service';
import { toSignupResponse } from '../views/organization.view';

/** POST /onboarding/signup — public; an organisation onboards itself. 201. */
export async function signup(req: Request, res: Response): Promise<void> {
  const org = await onboardingService.signup(req.body as SignupDto);
  res.status(201).json(toSignupResponse(org));
}
