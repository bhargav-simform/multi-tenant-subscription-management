import { ArrowUpRightIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

import { resolveRatio } from '@/components/common/usage-meter/resolveMeterTone';
import { USAGE_THRESHOLD } from '@/constants/plan';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useCurrentSubscription } from '@/hooks/subscription/queries';
import { formatBytes, interpolate } from '@/lib/utils';

/** Shown only once storage usage crosses the same WARN threshold UsageMeter uses to turn amber — no new magic number. */
export function StorageUpsellCard() {
    const { data: subscription } = useCurrentSubscription();
    if (!subscription) return null;

    const ratio = resolveRatio(subscription.usedStorageBytes, subscription.maxStorageBytes);
    if (ratio < USAGE_THRESHOLD.WARN) return null;

    return (
        <div className="mx-3 mb-3 rounded-2xl bg-sidebar-card-bg p-4">
            <p className="text-sm font-bold text-white">{LABELS.SIDEBAR.STORAGE_ALMOST_FULL_TITLE}</p>
            <p className="mt-1 text-xs text-sidebar-text-dim">
                {interpolate(LABELS.SIDEBAR.STORAGE_ALMOST_FULL_BODY, {
                    used: formatBytes(subscription.usedStorageBytes),
                    max: formatBytes(subscription.maxStorageBytes),
                })}
            </p>
            <Link to={ROUTES.PLAN} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent-500">
                {LABELS.SIDEBAR.UPGRADE_PLAN}
                <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
            </Link>
        </div>
    );
}
