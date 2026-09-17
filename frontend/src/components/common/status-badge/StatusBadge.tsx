import { cn } from '@/lib/utils';

export type BadgeTone = 'teal' | 'green' | 'amber' | 'red' | 'slate' | 'violet';

const TONE_CLASS: Record<BadgeTone, string> = {
    teal: 'bg-badge-teal-bg text-badge-teal-text border-badge-teal-border',
    green: 'bg-badge-green-bg text-badge-green-text border-badge-green-border',
    amber: 'bg-badge-amber-bg text-badge-amber-text border-badge-amber-border',
    red: 'bg-badge-red-bg text-badge-red-text border-badge-red-border',
    slate: 'bg-badge-slate-bg text-badge-slate-text border-badge-slate-border',
    violet: 'bg-badge-violet-bg text-badge-violet-text border-badge-violet-border',
};

/** A pill whose colour is chosen by the caller from the token set, never ad hoc. */
export function StatusBadge({
    tone = 'slate',
    children,
    className,
}: {
    tone?: BadgeTone;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <span
            className={cn(
                'inline-flex h-(--size-badge-height) w-fit shrink-0 items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium whitespace-nowrap',
                TONE_CLASS[tone],
                className,
            )}
        >
            {children}
        </span>
    );
}
