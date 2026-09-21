import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { toast } from 'sonner';

import { UsageMeter } from '@/components/common/usage-meter';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ROUTES } from '@/constants/routes';
import { USER_ROLE } from '@/constants/common';
import { LABELS } from '@/constants/labels';
import { useInviteUser } from '@/hooks/users/mutations';
import { useCurrentSubscription } from '@/hooks/subscription/queries';
import { interpolate } from '@/lib/utils';
import { inviteUserSchema, type InviteUserFormValues } from '@/schemas/users';

/**
 * Email delivery is stubbed for this MVP (no SMTP integration exists) — the
 * backend hands the raw invite token back in the response instead of ever
 * emailing it. Without this step, the only way to retrieve it was opening
 * DevTools and reading the network response by hand, which is not something
 * to ask an admin to do. This screen is the substitute for "check your
 * email": it shows the same link a real email would have contained, with a
 * one-click copy, so the admin can hand it to the invitee themselves (Slack,
 * a text, however) until real email sending exists.
 */
function buildInviteLink(token: string): string {
    const path = ROUTES.ACCEPT_INVITE.replace(':token', encodeURIComponent(token));
    return `${window.location.origin}${path}`;
}

export function InviteUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { mutateAsync: invite, isPending } = useInviteUser();
    const { data: subscription } = useCurrentSubscription();
    const [createdInvite, setCreatedInvite] = useState<{ email: string; link: string } | null>(null);
    const [copied, setCopied] = useState(false);

    const form = useForm<InviteUserFormValues>({
        resolver: zodResolver(inviteUserSchema),
        defaultValues: { email: '', role: USER_ROLE.ORG_MEMBER },
    });

    const onSubmit = async (values: InviteUserFormValues) => {
        // If this invite would take the organisation past its seat cap, the server
        // refuses with a 409 carrying a specific message, which the mutation shows
        // verbatim. The dialog stays open so the admin can see the refusal next to
        // the seat meter that explains it.
        const result = await invite(values).catch(() => null);
        if (!result) return;
        // tokenForDev is only present in this dev-mode stub — see buildInviteLink's
        // doc comment. A real deployment would email the link and never render this.
        if (result.tokenForDev) {
            setCreatedInvite({ email: values.email, link: buildInviteLink(result.tokenForDev) });
        } else {
            form.reset();
            onOpenChange(false);
        }
    };

    const closeAndReset = (open: boolean) => {
        onOpenChange(open);
        if (!open) {
            form.reset();
            setCreatedInvite(null);
            setCopied(false);
        }
    };

    const copyLink = async () => {
        if (!createdInvite) return;
        try {
            await navigator.clipboard.writeText(createdInvite.link);
            setCopied(true);
            toast.success(LABELS.USERS.INVITE_LINK_COPIED);
        } catch {
            toast.error(LABELS.USERS.INVITE_LINK_COPY_FAILED);
        }
    };

    if (createdInvite) {
        return (
            <Dialog open={open} onOpenChange={closeAndReset}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{LABELS.USERS.INVITE_LINK_TITLE}</DialogTitle>
                        <DialogDescription>
                            {interpolate(LABELS.USERS.INVITE_LINK_BODY, { email: createdInvite.email })}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex items-center gap-2">
                        <Input readOnly value={createdInvite.link} onFocus={(e) => e.currentTarget.select()} />
                        <Button type="button" variant="outline" size="icon" onClick={() => void copyLink()} aria-label={LABELS.USERS.INVITE_LINK_COPY}>
                            {copied ? <CheckIcon /> : <CopyIcon />}
                        </Button>
                    </div>

                    <DialogFooter>
                        <Button type="button" onClick={() => closeAndReset(false)}>
                            {LABELS.USERS.INVITE_LINK_DONE}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={closeAndReset}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{LABELS.USERS.INVITE_TITLE}</DialogTitle>
                    <DialogDescription>{LABELS.USERS.INVITE_SUBTITLE}</DialogDescription>
                </DialogHeader>

                {/* Shown before the attempt, so a full organisation is visible rather
                    than discovered through a rejection. It informs; it does not gate —
                    the button stays enabled and the server decides. */}
                {subscription && (
                    <UsageMeter
                        label={LABELS.PLAN.SEATS_LABEL}
                        used={subscription.usedSeats}
                        max={subscription.maxSeats}
                    />
                )}

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                        <FormField
                            control={form.control}
                            name="email"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel required>{LABELS.USERS.EMAIL}</FormLabel>
                                    <FormControl>
                                        <Input type="email" autoComplete="off" autoFocus {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="role"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel required>{LABELS.USERS.ROLE}</FormLabel>
                                    <Select value={field.value} onValueChange={field.onChange}>
                                        <FormControl>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                        </FormControl>
                                        <SelectContent>
                                            <SelectItem value={USER_ROLE.ORG_MEMBER}>{LABELS.USERS.ROLE_ORG_MEMBER}</SelectItem>
                                            <SelectItem value={USER_ROLE.ORG_ADMIN}>{LABELS.USERS.ROLE_ORG_ADMIN}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => closeAndReset(false)} disabled={isPending}>
                                {LABELS.COMMON.CANCEL}
                            </Button>
                            <Button type="submit" disabled={isPending}>
                                {isPending ? LABELS.USERS.SENDING : LABELS.USERS.SEND_INVITE}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}
