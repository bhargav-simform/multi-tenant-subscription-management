import { z } from 'zod';

import { USER_ROLE } from '@/constants/common';

/** user-service InviteUserDto: @IsEmail, @IsEnum(UserRole). */
export const inviteUserSchema = z.object({
    email: z.email('Enter a valid email address.'),
    role: z.enum([USER_ROLE.ORG_ADMIN, USER_ROLE.ORG_MEMBER], {
        message: 'Choose a role.',
    }),
});

export type InviteUserFormValues = z.infer<typeof inviteUserSchema>;

/** user-service UpdateRoleDto: @IsEnum(UserRole). */
export const updateRoleSchema = z.object({
    role: z.enum([USER_ROLE.ORG_ADMIN, USER_ROLE.ORG_MEMBER]),
});

export type UpdateRoleFormValues = z.infer<typeof updateRoleSchema>;
