import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { isAxiosError } from 'axios';
import { RouterProvider } from 'react-router-dom';
import { toast } from 'sonner';

import { Toaster } from '@/components/ui/sonner';
import { QUERY_META, STALE_TIME } from '@/constants/common';
import { LABELS } from '@/constants/labels';
import { AuthProvider } from '@/contexts/AuthContext';
import { IS_DEV } from '@/lib/env';
import { getErrorMessage } from '@/lib/utils';
import { router } from '@/routes';

import './index.css';

const queryClient = new QueryClient({
    queryCache: new QueryCache({
        onError: (error, query) => {
            // Queries that own their failures opt out — notably the by-id reads,
            // where a 404 is the correct cross-tenant answer and not an error worth
            // shouting about.
            if (query.meta?.[QUERY_META.SUPPRESS_ERROR_TOAST] === true) return;
            // A missing response is already reported once by the axios interceptor's
            // deduplicated network toast; a second one here would double it.
            if (isAxiosError(error) && !error.response) return;
            toast.error(getErrorMessage(error, LABELS.COMMON.FETCH_ERROR));
        },
    }),
    defaultOptions: {
        queries: {
            staleTime: STALE_TIME.FIVE_MINUTES,
            // Never retry a 4xx: a 403 or a cross-tenant 404 will answer the same way
            // every time, and retrying an authorization failure only adds noise to the
            // audit trail. One retry for a genuine server fault.
            retry: (failureCount, error) => {
                if (isAxiosError(error) && (error.response?.status ?? 0) >= 500) return failureCount < 1;
                return false;
            },
        },
    },
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <AuthProvider>
                <RouterProvider router={router} />
                <Toaster />
                {IS_DEV && <ReactQueryDevtools initialIsOpen={false} />}
            </AuthProvider>
        </QueryClientProvider>
    </StrictMode>,
);
