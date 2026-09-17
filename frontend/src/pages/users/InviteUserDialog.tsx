import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

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
import { USER_ROLE } from '@/constants/common';
import { LABELS } from '@/constants/labels';
import { useInviteUser } from '@/hooks/users/mutations';
import { useCurrentSubscription } from '@/hooks/subscription/queries';
import { inviteUserSchema, type InviteUserFormValues } from '@/schemas/users';

export function InviteUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { mutateAsync: invite, isPending } = useInviteUser();
    const { data: subscription } = useCurrentSubscription();

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
        form.reset();
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
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
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
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
