import { toast } from 'sonner';

import { LABELS } from '@/constants/labels';
import { PLAN_LIMIT_EXCEEDED } from '@/constants/plan';
import { getErrorCode, getErrorMessage, getErrorStatus } from '@/lib/utils';

/**
 * How a refused action is reported to the user.
 *
 * When the server refuses on a plan limit it writes a specific, human-readable
 * message ("Inviting this user would exceed the Free plan's limit of 3 seats").
 * Requirement R6 asks for exactly that — a clear, specific refusal rather than a
 * generic error — so the server's own message is shown VERBATIM and never
 * replaced with a friendlier local string.
 *
 * A 409 without the code still gets its server message: a conflict the backend
 * bothered to describe is always more useful than "Something went wrong".
 */
export const isPlanLimitError = (error: unknown): boolean =>
    getErrorCode(error) === PLAN_LIMIT_EXCEEDED || getErrorStatus(error) === 409;

export const showMutationError = (error: unknown, fallback: string = LABELS.COMMON.GENERIC_ERROR): void => {
    if (isPlanLimitError(error)) {
        // No fallback: if the server sent a 409 it sent a reason with it.
        toast.error(getErrorMessage(error, fallback), { duration: 8000 });
        return;
    }
    toast.error(getErrorMessage(error, fallback));
};
