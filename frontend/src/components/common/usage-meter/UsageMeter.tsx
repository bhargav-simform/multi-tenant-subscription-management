import { resolveRatio, resolveTone, type MeterTone } from '@/components/common/usage-meter/resolveMeterTone';
import { cn } from '@/lib/utils';

export interface UsageMeterProps {
    label: string;
    used: number;
    max: number;
    /** How to render the raw numbers, e.g. formatBytes for storage. */
    format?: (value: number) => string;
    className?: string;
}

const TONE_CLASS: Record<MeterTone, string> = {
    safe: 'bg-meter-safe',
    warn: 'bg-meter-warn',
    full: 'bg-meter-full',
};

const TONE_TEXT: Record<MeterTone, string> = {
    safe: 'text-muted-foreground',
    warn: 'text-badge-amber-text',
    full: 'text-badge-red-text',
};

/**
 * A plan limit, drawn.
 *
 * The colour change at 80% is a COURTESY, not a control: the server refuses the
 * action, and it refuses it at 100%. A user who ignores an amber bar is stopped
 * by a 409 with a specific message, not by this component. Colour is never the
 * only signal — the same state is in the text beside it and in `aria-valuetext`.
 */
export function UsageMeter({ label, used, max, format, className }: UsageMeterProps) {
    const ratio = resolveRatio(used, max);
    const tone = resolveTone(ratio);
    const percent = Math.min(100, Math.round(ratio * 100));
    const render = format ?? ((value: number) => value.toLocaleString());
    const valueText = `${render(used)} of ${render(max)} used`;

    return (
        <div className={cn('flex flex-col gap-1.5', className)}>
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{label}</span>
                <span className={cn('text-xs tabular-nums', TONE_TEXT[tone])}>{valueText}</span>
            </div>
            <div
                role="progressbar"
                aria-label={label}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuetext={valueText}
                className="h-2 w-full overflow-hidden rounded-full bg-meter-track"
            >
                <div
                    className={cn('h-full rounded-full transition-all', TONE_CLASS[tone])}
                    style={{ width: `${percent}%` }}
                />
            </div>
        </div>
    );
}
