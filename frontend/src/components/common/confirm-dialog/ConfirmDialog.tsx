import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { LABELS } from '@/constants/labels';
import { cn } from '@/lib/utils';

/** Destructive confirmations. Radix traps focus and closes on Escape for us. */
export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    body,
    confirmLabel = LABELS.COMMON.CONFIRM,
    isPending,
    onConfirm,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    body?: string;
    confirmLabel?: string;
    isPending?: boolean;
    onConfirm: () => void;
}) {
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    {body && <AlertDialogDescription>{body}</AlertDialogDescription>}
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isPending}>{LABELS.COMMON.CANCEL}</AlertDialogCancel>
                    <AlertDialogAction
                        disabled={isPending}
                        onClick={(event) => {
                            // The dialog is closed by the caller once the mutation settles,
                            // so a failed delete does not silently dismiss its own error.
                            event.preventDefault();
                            onConfirm();
                        }}
                        className={cn(buttonVariants({ variant: 'destructive' }))}
                    >
                        {confirmLabel}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
