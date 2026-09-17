import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useLogin } from '@/hooks/auth/mutations';
import { getErrorMessage, getErrorStatus } from '@/lib/utils';
import { loginSchema, type LoginFormValues } from '@/schemas/auth';

import { AuthShell } from './AuthShell';

export default function LoginPage() {
    const navigate = useNavigate();
    const { mutateAsync: login, isPending, error } = useLogin();

    const form = useForm<LoginFormValues>({
        resolver: zodResolver(loginSchema),
        defaultValues: { email: '', password: '' },
    });

    const onSubmit = async (values: LoginFormValues) => {
        const user = await login(values).catch(() => null);
        if (!user) return;
        // A platform admin has no organisation, so the tenant dashboard has nothing
        // to show them — they start in their own shell.
        const isPlatformAdmin = user.organizationId === null;
        void navigate(isPlatformAdmin ? ROUTES.ADMIN_ORGANIZATIONS : ROUTES.DASHBOARD, { replace: true });
    };

    /**
     * A 401 here means the pair did not match. It is shown as one message against
     * the form rather than against a field: saying which half was wrong tells an
     * attacker whether an email exists.
     */
    const formError = error
        ? getErrorStatus(error) === 401
            ? LABELS.AUTH.INVALID_CREDENTIALS
            : getErrorMessage(error, LABELS.COMMON.GENERIC_ERROR)
        : null;

    return (
        <AuthShell
            title={LABELS.AUTH.LOGIN_TITLE}
            subtitle={LABELS.AUTH.LOGIN_SUBTITLE}
            footer={
                <>
                    {LABELS.AUTH.NO_ACCOUNT}{' '}
                    <Link to={ROUTES.SIGNUP} className="font-medium text-primary underline-offset-4 hover:underline">
                        {LABELS.AUTH.CREATE_ORG}
                    </Link>
                </>
            }
        >
            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                    <FormField
                        control={form.control}
                        name="email"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel required>{LABELS.AUTH.EMAIL}</FormLabel>
                                <FormControl>
                                    <Input type="email" autoComplete="email" autoFocus {...field} />
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
                                <FormLabel required>{LABELS.AUTH.PASSWORD}</FormLabel>
                                <FormControl>
                                    <Input type="password" autoComplete="current-password" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />

                    {formError && (
                        <p role="alert" aria-live="polite" className="text-sm text-destructive">
                            {formError}
                        </p>
                    )}

                    <Button type="submit" disabled={isPending} className="mt-1">
                        {isPending ? LABELS.AUTH.SIGNING_IN : LABELS.AUTH.SIGN_IN}
                    </Button>
                </form>
            </Form>
        </AuthShell>
    );
}
