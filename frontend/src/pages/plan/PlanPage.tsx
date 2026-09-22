import { useState } from 'react';
import { CheckIcon, InfoIcon } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PageErrorState, PageLoadingState } from '@/components/common/page-state';
import { StatusBadge } from '@/components/common/status-badge';
import { UsageMeter } from '@/components/common/usage-meter';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LABELS } from '@/constants/labels';
import { PLAN_ORDER } from '@/constants/plan';
import { useChangePlan } from '@/hooks/subscription/mutations';
import { useCurrentSubscription, usePlans } from '@/hooks/subscription/queries';
import { formatBytes, interpolate } from '@/lib/utils';
import type { Plan } from '@/types/api';

const byCatalogueOrder = (a: Plan, b: Plan) => PLAN_ORDER.indexOf(a.code) - PLAN_ORDER.indexOf(b.code);

export default function PlanPage() {
    const { data: subscription, isLoading, isError, refetch } = useCurrentSubscription();
    const { data: plans } = usePlans();
    const { mutate: changePlan, isPending } = useChangePlan();
    const [pendingPlan, setPendingPlan] = useState<Plan | null>(null);

    if (isLoading) return <PageLoadingState />;
    if (isError || !subscription) return <PageErrorState onRetry={() => void refetch()} />;

    const sortedPlans = [...(plans ?? [])].sort(byCatalogueOrder);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
                <h1>{LABELS.PLAN.TITLE}</h1>
                <p className="text-sm text-muted-foreground">{LABELS.PLAN.SUBTITLE}</p>
            </div>

            <Card accent="violet">
                <CardHeader>
                    <CardDescription>{LABELS.PLAN.CURRENT_PLAN}</CardDescription>
                    <CardTitle className="flex items-center gap-2 text-2xl">
                        {subscription.planName}
                        <StatusBadge tone={subscription.status === 'active' ? 'green' : 'amber'}>
                            {subscription.status}
                        </StatusBadge>
                    </CardTitle>
                </CardHeader>
                <CardContent className="grid gap-5 sm:grid-cols-2">
                    <UsageMeter
                        label={LABELS.PLAN.SEATS_LABEL}
                        used={subscription.usedSeats}
                        max={subscription.maxSeats}
                    />
                    <UsageMeter
                        label={LABELS.PLAN.STORAGE_LABEL}
                        used={subscription.usedStorageBytes}
                        max={subscription.maxStorageBytes}
                        format={formatBytes}
                    />
                </CardContent>
            </Card>

            <div className="flex flex-col gap-3">
                <h2 className="text-lg font-semibold">{LABELS.PLAN.CHANGE_PLAN}</h2>
                {/* A downgrade below current usage is refused server-side with a specific
                    message. Saying so up front is kinder than letting the admin discover
                    it — but the refusal, not this sentence, is the enforcement. */}
                <div className="flex items-start gap-2 rounded-lg border border-border bg-section-header-bg px-4 py-3">
                    <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">{LABELS.PLAN.DOWNGRADE_WARNING}</p>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                    {sortedPlans.map((plan) => {
                        const isCurrent = plan.code === subscription.planCode;
                        return (
                            <Card key={plan.id} className={isCurrent ? 'border-primary' : undefined}>
                                <CardHeader>
                                    <CardDescription>{plan.code}</CardDescription>
                                    <CardTitle className="text-xl">{plan.name}</CardTitle>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-3">
                                    <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                                        <li className="flex items-center gap-2">
                                            <CheckIcon className="size-4 text-primary" aria-hidden="true" />
                                            {interpolate(LABELS.PLAN.MAX_USERS, { count: plan.maxUsers })}
                                        </li>
                                        <li className="flex items-center gap-2">
                                            <CheckIcon className="size-4 text-primary" aria-hidden="true" />
                                            {interpolate(LABELS.PLAN.MAX_STORAGE, { size: formatBytes(plan.maxStorageBytes) })}
                                        </li>
                                    </ul>
                                    <Button
                                        variant={isCurrent ? 'outline' : 'default'}
                                        disabled={isCurrent || isPending}
                                        onClick={() => setPendingPlan(plan)}
                                    >
                                        {isCurrent ? LABELS.PLAN.CURRENT : LABELS.PLAN.SELECT}
                                    </Button>
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            </div>

            <ConfirmDialog
                open={Boolean(pendingPlan)}
                onOpenChange={(open) => !open && setPendingPlan(null)}
                title={interpolate(LABELS.PLAN.CHANGED, { plan: pendingPlan?.name ?? '' })}
                body={LABELS.PLAN.DOWNGRADE_WARNING}
                confirmLabel={LABELS.PLAN.CHANGE_PLAN}
                isPending={isPending}
                onConfirm={() => {
                    if (!pendingPlan) return;
                    changePlan(pendingPlan.code, { onSettled: () => setPendingPlan(null) });
                }}
            />
        </div>
    );
}
