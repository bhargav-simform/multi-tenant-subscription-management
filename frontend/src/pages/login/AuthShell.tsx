import type { ReactNode } from 'react';

import { LABELS } from '@/constants/labels';

/** The framing for every unauthenticated screen: login, signup, invite acceptance. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
    return (
        <div className="grid min-h-svh lg:grid-cols-2">
            <div className="bg-sidebar-gradient hidden flex-col justify-between p-10 lg:flex">
                <p className="text-lg font-semibold text-sidebar-foreground">{LABELS.COMMON.APP_NAME}</p>
                <div className="flex flex-col gap-3">
                    <p className="text-2xl leading-snug font-semibold text-sidebar-foreground">
                        Every organisation’s data, isolated by the architecture.
                    </p>
                    <p className="max-w-md text-sm text-sidebar-foreground/75">
                        Not by remembering to write a filter on every query — by row-level security that a
                        query cannot bypass even when its author forgets.
                    </p>
                </div>
                <p className="text-xs text-sidebar-foreground/60">Multi-tenant subscription management</p>
            </div>

            <div className="flex items-center justify-center p-6 lg:p-10">
                <div className="flex w-full max-w-sm flex-col gap-6">
                    <div className="flex flex-col gap-2">
                        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
                    </div>
                    {children}
                    {footer && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
                </div>
            </div>
        </div>
    );
}
