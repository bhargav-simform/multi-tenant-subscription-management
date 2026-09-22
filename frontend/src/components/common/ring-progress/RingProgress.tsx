import { resolveRatio, resolveTone, type MeterTone } from '@/components/common/usage-meter/resolveMeterTone';
import { cn } from '@/lib/utils';

const TONE_STROKE: Record<MeterTone, string> = {
    safe: 'stroke-meter-safe',
    warn: 'stroke-meter-warn',
    full: 'stroke-meter-full',
};

export interface RingProgressProps {
    used: number;
    max: number;
    /** Small sub-label shown under the value in the ring's center, e.g. "USED". */
    label?: string;
    size?: number;
    strokeWidth?: number;
    className?: string;
}

/** A circular progress ring sharing UsageMeter's exact ratio/tone/threshold logic, for compact stat-card display. */
export function RingProgress({ used, max, label, size = 88, strokeWidth = 9, className }: RingProgressProps) {
    const ratio = resolveRatio(used, max);
    const tone = resolveTone(ratio);
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - Math.min(1, ratio));
    const center = size / 2;
    const valueText = `${used} of ${max} used`;

    return (
        <div className={cn('relative inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
            <svg width={size} height={size} className="-rotate-90" role="img" aria-label={label ?? valueText}>
                <circle cx={center} cy={center} r={radius} strokeWidth={strokeWidth} className="fill-none stroke-meter-track" />
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    className={cn('fill-none transition-all', TONE_STROKE[tone])}
                />
            </svg>
            <span className="sr-only">{valueText}</span>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5" aria-hidden="true">
                <span className="text-base font-bold tabular-nums text-foreground">
                    {used}/{max}
                </span>
                {label && <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>}
            </div>
        </div>
    );
}
