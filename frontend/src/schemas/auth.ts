import { z } from 'zod';

import { LABELS } from '@/constants/labels';

/**
 * Client-side mirrors of the backend DTO validators.
 *
 * These exist so a malformed email or a short password is caught before a round
 * trip — requirement §6's "bad input rejected before it reaches your business
 * logic", applied at the edge the user actually sees. The server validates
 * independently and always; this schema is a convenience, never the control.
 * Every rule here has a counterpart in a class-validator decorator.
 */

/** auth-service LoginDto: @IsEmail, @IsString @MinLength(1). */
export const loginSchema = z.object({
    email: z.email('Enter a valid email address.'),
    password: z.string().min(1, 'Enter your password.'),
});

export type LoginFormValues = z.infer<typeof loginSchema>;

/** tenant-service SignupDto. The 12-character minimum is the backend's, not a guess. */
export const signupSchema = z.object({
    organizationName: z
        .string()
        .trim()
        .min(2, 'Organisation name must be at least 2 characters.')
        .max(255, 'Organisation name must be at most 255 characters.'),
    adminFirstName: z.string().trim().min(1, 'Enter a first name.').max(255, 'First name is too long.'),
    adminLastName: z.string().trim().min(1, 'Enter a last name.').max(255, 'Last name is too long.'),
    adminEmail: z.email('Enter a valid email address.'),
    adminPassword: z
        .string()
        .min(12, LABELS.SIGNUP.PASSWORD_HINT)
        .max(255, 'Password is too long.'),
});

export type SignupFormValues = z.infer<typeof signupSchema>;

/** user-service AcceptInvitationDto: @IsString @MinLength(1) on both names. */
export const acceptInvitationSchema = z.object({
    firstName: z.string().trim().min(1, 'Enter your first name.'),
    lastName: z.string().trim().min(1, 'Enter your last name.'),
});

export type AcceptInvitationFormValues = z.infer<typeof acceptInvitationSchema>;
