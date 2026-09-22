import { ScrollTextIcon, UploadIcon, UserPlusIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

import { resolveRatio } from '@/components/common/usage-meter/resolveMeterTone';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LABELS } from '@/constants/labels';
import { USAGE_THRESHOLD } from '@/constants/plan';
import { ROUTES } from '@/constants/routes';
import { useAuditEvents } from '@/hooks/audit/queries';
import { useCurrentSubscription } from '@/hooks/subscription/queries';
import { cn, formatBytes, formatRelativeTime, interpolate } from '@/lib/utils';

interface QuickActionRow {
    to: string;
    icon: typeof UserPlusIcon;
    title: string;
    subtitle: string;
}

export function QuickActionsPanel() {
    const { data: subscription } = useCurrentSubscription();
    // Most-recent-first is confirmed server-side (audit-record.repository.ts
    // orders by occurredAt DESC), so items[0] here really is the latest event.
    const { data: recentAudit } = useAuditEvents(undefined, 1);

    const seatsRemaining = subscription ? subscription.maxSeats - subscription.usedSeats : undefined;
    const storageRatio = subscription ? resolveRatio(subscription.usedStorageBytes, subscription.maxStorageBytes) : 0;
    const latestEvent = recentAudit?.items[0];

    const rows: QuickActionRow[] = [
        {
            to: ROUTES.USERS,
            icon: UserPlusIcon,
            title: LABELS.QUICK_ACTIONS.INVITE_USER,
            subtitle:
                seatsRemaining !== undefined
                    ? interpolate(LABELS.QUICK_ACTIONS.INVITE_USER_SUBTITLE, { count: seatsRemaining })
                    : '',
        },
        {
            to: ROUTES.RESOURCES,
            icon: UploadIcon,
            title: LABELS.QUICK_ACTIONS.UPLOAD_RESOURCE,
            subtitle:
                storageRatio >= USAGE_THRESHOLD.WARN
                    ? LABELS.QUICK_ACTIONS.UPLOAD_RESOURCE_SUBTITLE_FULL
                    : subscription
                      ? interpolate(LABELS.QUICK_ACTIONS.UPLOAD_RESOURCE_SUBTITLE_OK, {
                            used: formatBytes(subscription.usedStorageBytes),
                        })
                      : '',
        },
        {
            to: ROUTES.AUDIT,
            icon: ScrollTextIcon,
            title: LABELS.QUICK_ACTIONS.REVIEW_AUDIT,
            subtitle: latestEvent ? formatRelativeTime(latestEvent.occurredAt) : LABELS.QUICK_ACTIONS.REVIEW_AUDIT_SUBTITLE,
        },
    ];

    return (
        <Card>
            <CardHeader>
                <CardTitle>{LABELS.QUICK_ACTIONS.TITLE}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
                {rows.map((row) => (
                    <Link
                        key={row.to + row.title}
                        to={row.to}
                        className={cn(
                            'flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted',
                            'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                        )}
                    >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <row.icon className="size-4 text-muted-foreground" aria-hidden="true" />
                        </span>
                        <div className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-medium">{row.title}</span>
                            <span className="truncate text-xs text-muted-foreground">{row.subtitle}</span>
                        </div>
                    </Link>
                ))}
            </CardContent>
        </Card>
    );
}
