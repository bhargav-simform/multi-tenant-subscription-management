'use client';

import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
    return (
        <Sonner
            position="top-right"
            className="toaster group"
            icons={{
                success: <CircleCheckIcon className="size-5" />,
                info: <InfoIcon className="size-5" />,
                warning: <TriangleAlertIcon className="size-5" />,
                error: <OctagonXIcon className="size-5" />,
                loading: <Loader2Icon className="size-5 animate-spin" />,
            }}
            {...props}
        />
    );
};

export { Toaster };
