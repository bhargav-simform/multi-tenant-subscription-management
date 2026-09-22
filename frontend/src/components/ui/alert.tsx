import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const alertVariants = cva('relative flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-sm', {
    variants: {
        tone: {
            teal: 'bg-badge-teal-bg border-badge-teal-border text-badge-teal-text',
            green: 'bg-badge-green-bg border-badge-green-border text-badge-green-text',
            amber: 'bg-badge-amber-bg border-badge-amber-border text-badge-amber-text',
            red: 'bg-badge-red-bg border-badge-red-border text-badge-red-text',
            slate: 'bg-badge-slate-bg border-badge-slate-border text-badge-slate-text',
            violet: 'bg-badge-violet-bg border-badge-violet-border text-badge-violet-text',
        },
    },
    defaultVariants: {
        tone: 'slate',
    },
});

function Alert({ className, tone, ...props }: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
    return <div data-slot="alert" role="alert" className={cn(alertVariants({ tone }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<'p'>) {
    return <p data-slot="alert-title" className={cn('font-medium leading-none', className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'p'>) {
    return <p data-slot="alert-description" className={cn('text-sm opacity-90', className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
