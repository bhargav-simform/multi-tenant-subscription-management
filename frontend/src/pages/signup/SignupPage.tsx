import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { AuthShell } from '@/pages/login/AuthShell';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useSignup } from '@/hooks/auth/mutations';
import { generateIdempotencyKey, getErrorMessage } from '@/lib/utils';
import { signupSchema, type SignupFormValues } from '@/schemas/auth';

export default function SignupPage() {
    const navigate = useNavigate();
    const { mutateAsync: signup, isPending, error } = useSignup();

    /**
     * ONE key per form mount, generated up front and reused for every attempt.
     *
     * This is the whole mechanism behind "a half-created organisation must not
     * block a retry". If the first attempt dies after the organisation row is
     * written but before the admin user is, the user presses the button again —
     * and because the SAME key arrives, tenant-service recognises the retry and
     * completes the original attempt instead of creating a second organisation.
     *
     * A key regenerated per submit would turn every retry into a fresh signup,
     * which is precisely the orphaned-data case the requirement rules out.
     * `useState`'s lazy initializer runs the generator exactly once, on first
     * render, and the setter is never called again — a `useRef` would do the
     * same job, but a ref read from inside the `onSubmit` closure below is what
     * the React Compiler's lint (correctly, in general) treats as a possible
     * stale/render-time ref access, so state sidesteps that without changing
     * the actual "generate once, reuse on retry" behaviour.
     */
    const [idempotencyKey] = useState<string>(generateIdempotencyKey);

    const form = useForm<SignupFormValues>({
        resolver: zodResolver(signupSchema),
        defaultValues: {
            organizationName: '',
            adminFirstName: '',
            adminLastName: '',
            adminEmail: '',
            adminPassword: '',
        },
    });

    const onSubmit = async (values: SignupFormValues) => {
        const result = await signup({ ...values, idempotencyKey }).catch(() => null);
        if (!result) return;
        toast.success(LABELS.SIGNUP.SUCCESS);
        void navigate(ROUTES.LOGIN, { replace: true });
    };

    return (
        <AuthShell
            title={LABELS.SIGNUP.TITLE}
            subtitle={LABELS.SIGNUP.SUBTITLE}
            footer={
                <>
                    {LABELS.AUTH.HAVE_ACCOUNT}{' '}
                    <Link to={ROUTES.LOGIN} className="font-medium text-primary underline-offset-4 hover:underline">
                        {LABELS.AUTH.SIGN_IN}
                    </Link>
                </>
            }
        >
            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                    <FormField
                        control={form.control}
                        name="organizationName"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel required>{LABELS.SIGNUP.ORG_NAME}</FormLabel>
                                <FormControl>
                                    <Input autoComplete="organization" autoFocus {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />

                    <div className="grid grid-cols-2 gap-3">
                        <FormField
                            control={form.control}
                            name="adminFirstName"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel required>{LABELS.SIGNUP.ADMIN_FIRST_NAME}</FormLabel>
                                    <FormControl>
                                        <Input autoComplete="given-name" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="adminLastName"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel required>{LABELS.SIGNUP.ADMIN_LAST_NAME}</FormLabel>
                                    <FormControl>
                                        <Input autoComplete="family-name" {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                    </div>

                    <FormField
                        control={form.control}
                        name="adminEmail"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel required>{LABELS.SIGNUP.ADMIN_EMAIL}</FormLabel>
                                <FormControl>
                                    <Input type="email" autoComplete="email" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />

                    <FormField
                        control={form.control}
                        name="adminPassword"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel required>{LABELS.SIGNUP.ADMIN_PASSWORD}</FormLabel>
                                <FormControl>
                                    <Input type="password" autoComplete="new-password" {...field} />
                                </FormControl>
                                <FormDescription>{LABELS.SIGNUP.PASSWORD_HINT}</FormDescription>
                                <FormMessage />
                            </FormItem>
                        )}
                    />

                    {error && (
                        <div role="alert" aria-live="polite" className="flex flex-col gap-1">
                            <p className="text-sm text-destructive">{getErrorMessage(error, LABELS.COMMON.GENERIC_ERROR)}</p>
                            {/* Said plainly, because a failed signup is exactly when a user
                                worries that trying again will double-create something. */}
                            <p className="text-xs text-muted-foreground">{LABELS.SIGNUP.RETRY_SAFE}</p>
                        </div>
                    )}

                    <Button type="submit" disabled={isPending} className="mt-1">
                        {isPending ? LABELS.SIGNUP.SUBMITTING : LABELS.SIGNUP.SUBMIT}
                    </Button>
                </form>
            </Form>
        </AuthShell>
    );
}
