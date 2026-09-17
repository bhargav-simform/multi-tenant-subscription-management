import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';

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
import { Textarea } from '@/components/ui/textarea';
import { LABELS } from '@/constants/labels';
import { useCreateResource } from '@/hooks/resources/mutations';
import { createResourceSchema, type CreateResourceFormValues } from '@/schemas/resources';

export function ResourceFormDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { mutateAsync: create, isPending } = useCreateResource();

    const form = useForm<CreateResourceFormValues>({
        resolver: zodResolver(createResourceSchema),
        defaultValues: { name: '', description: '', sizeBytes: 0 },
    });

    const onSubmit = async (values: CreateResourceFormValues) => {
        // A storage-limit refusal is reported by the mutation's own toast, with the
        // server's specific message. The dialog stays open so the user can adjust
        // the size and try again rather than losing what they typed.
        const result = await create({
            name: values.name,
            sizeBytes: values.sizeBytes,
            ...(values.description ? { description: values.description } : {}),
        }).catch(() => null);
        if (!result) return;
        form.reset();
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{LABELS.RESOURCES.CREATE_TITLE}</DialogTitle>
                    <DialogDescription>{LABELS.RESOURCES.SUBTITLE}</DialogDescription>
                </DialogHeader>

                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
                        <FormField
                            control={form.control}
                            name="name"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel required>{LABELS.RESOURCES.NAME}</FormLabel>
                                    <FormControl>
                                        <Input autoFocus {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="description"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>{LABELS.RESOURCES.DESCRIPTION}</FormLabel>
                                    <FormControl>
                                        <Textarea rows={3} {...field} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="sizeBytes"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel required>{LABELS.RESOURCES.SIZE_BYTES}</FormLabel>
                                    <FormControl>
                                        <Input
                                            type="number"
                                            min={0}
                                            step={1}
                                            {...field}
                                            // A number input hands back a string; the schema expects a
                                            // number, so it is converted here rather than loosened there.
                                            onChange={(event) => field.onChange(event.target.valueAsNumber || 0)}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
                                {LABELS.COMMON.CANCEL}
                            </Button>
                            <Button type="submit" disabled={isPending}>
                                {isPending ? LABELS.RESOURCES.SUBMITTING : LABELS.RESOURCES.SUBMIT}
                            </Button>
                        </DialogFooter>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}
