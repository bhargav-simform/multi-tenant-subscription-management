import type { LucideIcon } from 'lucide-react';

import type { BadgeTone } from '@/components/common/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const ICON_WRAPPER_CLASS: Record<BadgeTone, string> = {
    teal: 'bg-card-accent-teal/10 text-card-accent-teal',
    green: 'bg-card-accent-green/10 text-card-accent-green',
    amber: 'bg-card-accent-amber/10 text-card-accent-amber',
    red: 'bg-card-accent-red/10 text-card-accent-red',
    slate: 'bg-card-accent-slate/10 text-card-accent-slate',
    violet: 'bg-card-accent-violet/10 text-card-accent-violet',
};

export interface StatCardProps {
    icon: LucideIcon;
    tone: BadgeTone;
    label: string;
    value: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
}

/** A stat/metric card with an icon accent — used for Plan/Seats/Storage-style tiles. */
export function StatCard({ icon: Icon, tone, label, value, children, className }: StatCardProps) {
    return (
        <Card className={className}>
            <CardHeader>
                <div className={cn('flex size-9 items-center justify-center rounded-lg', ICON_WRAPPER_CLASS[tone])}>
                    <Icon className="size-5" aria-hidden="true" />
                </div>
                <CardDescription className="text-xs font-medium tracking-wide uppercase">{label}</CardDescription>
                <CardTitle className="text-2xl">{value}</CardTitle>
            </CardHeader>
            {children && <CardContent>{children}</CardContent>}
        </Card>
    );
}
