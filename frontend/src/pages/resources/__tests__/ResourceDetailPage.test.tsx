import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resourcesApi } from '@/services/resources/resourcesApi';

import ResourceDetailPage from '../ResourceDetailPage';

vi.mock('@/services/resources/resourcesApi', () => ({
    resourcesApi: { getById: vi.fn() },
}));

const renderAt = (path: string) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path="/resources/:id" element={<ResourceDetailPage />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    );
};

/**
 * H1, from the client's side: a well-formed request for another organisation's
 * resource id must render as "does not exist" — never as a generic error, and
 * never phrased in a way that confirms the row exists for someone else.
 */
describe('ResourceDetailPage — H1 cross-tenant read', () => {
    beforeEach(() => {
        vi.mocked(resourcesApi.getById).mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders a not-found state on a 404, not the generic error state', async () => {
        vi.mocked(resourcesApi.getById).mockRejectedValueOnce({
            response: { status: 404, data: { message: 'Not Found' } },
        });

        renderAt('/resources/00000000-0000-0000-0000-000000000000');

        await waitFor(() => {
            expect(screen.getByText('That resource does not exist.')).toBeInTheDocument();
        });

        // The generic "could not load" error copy must NOT appear — a 404 here is
        // a correct, expected answer, not a failure to surface as a retry-able error.
        expect(screen.queryByText('Could not load this data. Please try again.')).not.toBeInTheDocument();
    });

    it('renders the actual generic error state for a real server fault (500)', async () => {
        vi.mocked(resourcesApi.getById).mockRejectedValueOnce({
            response: { status: 500, data: {} },
        });

        renderAt('/resources/00000000-0000-0000-0000-000000000000');

        await waitFor(() => {
            expect(screen.getByText('Could not load this data. Please try again.')).toBeInTheDocument();
        });
    });

    it('renders the resource when it belongs to the caller’s own organisation', async () => {
        vi.mocked(resourcesApi.getById).mockResolvedValueOnce({
            id: '00000000-0000-0000-0000-000000000000',
            name: 'Q3 report.pdf',
            description: null,
            sizeBytes: 2048,
            createdBy: 'user-1',
            createdAt: '2026-01-01T00:00:00.000Z',
        });

        renderAt('/resources/00000000-0000-0000-0000-000000000000');

        await waitFor(() => {
            expect(screen.getByRole('heading', { name: 'Q3 report.pdf' })).toBeInTheDocument();
        });
    });
});
