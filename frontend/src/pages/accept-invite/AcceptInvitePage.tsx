import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';

import { AuthShell } from '@/pages/login/AuthShell';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useAcceptInvitation } from '@/hooks/auth/mutations';
import { getErrorMessage, getErrorStatus } from '@/lib/utils';
import { acceptInvitationSchema, type AcceptInvitationFormValues } from '@/schemas/auth';

/**
 * The invitation token in the URL IS the credential.
 *
 * An invitee has no account yet, so there is no session to require. The token is
 * single-use, hashed at rest and expiring, and it resolves to exactly one
 * invitation in exactly one organisation — so it carries its own tenant scope.
 * Nothing here validates it; user-service does, and a bad token comes back as a
 * plain refusal.
 */
export default function AcceptInvitePage() {
    const { token } = useParams<{ token: string }>();
    const navigate = useNavigate();
    const { mutateAsync: accept, isPending, error } = useAcceptInvitation();

    const form = useForm<AcceptInvitationFormValues>({
        resolver: zodResolver(acceptInvitationSchema),
        defaultValues: { firstName: '', lastName: '', password: '' },
    });

    const onSubmit = async (values: AcceptInvitationFormValues) => {
        if (!token) return;
        const result = await accept({ token, payload: values }).catch(() => null);
        if (!result) return;
        toast.success(LABELS.INVITE_ACCEPT.SUCCESS);
        void navigate(ROUTES.LOGIN, { replace: true });
    };

    // A spent, expired or invented token is a 404/400 — all the same thing to the
    // invitee, and phrased so they know to ask for a new invitation.
    const status = getErrorStatus(error);
    const formError = error
        ? status === 404 || status === 400 || status === 410
            ? LABELS.INVITE_ACCEPT.INVALID
            : getErrorMessage(error, LABELS.COMMON.GENERIC_ERROR)
        : null;

    return (
        <AuthShell
            title={LABELS.INVITE_ACCEPT.TITLE}
            subtitle={LABELS.INVITE_ACCEPT.SUBTITLE}
            footer={
                <Link to={ROUTES.LOGIN} className="font-medium text-primary underline-offset-4 hover:underline">
                    {LABELS.AUTH.SIGN_IN}
                </Link>
            }
        >
            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                    <FormField
                        control={form.control}
                        name="firstName"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel required>{LABELS.INVITE_ACCEPT.FIRST_NAME}</FormLabel>
                                <FormControl>
                                    <Input autoComplete="given-name" autoFocus {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="lastName"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel required>{LABELS.INVITE_ACCEPT.LAST_NAME}</FormLabel>
                                <FormControl>
                                    <Input autoComplete="family-name" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="password"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel required>{LABELS.INVITE_ACCEPT.PASSWORD}</FormLabel>
                                <FormControl>
                                    <Input type="password" autoComplete="new-password" {...field} />
                                </FormControl>
                                <FormDescription>{LABELS.SIGNUP.PASSWORD_HINT}</FormDescription>
                                <FormMessage />
                            </FormItem>
                        )}
                    />

                    {formError && (
                        <p role="alert" aria-live="polite" className="text-sm text-destructive">
                            {formError}
                        </p>
                    )}

                    <Button type="submit" disabled={isPending || !token} className="mt-1">
                        {isPending ? LABELS.INVITE_ACCEPT.SUBMITTING : LABELS.INVITE_ACCEPT.SUBMIT}
                    </Button>
                </form>
            </Form>
        </AuthShell>
    );
}
