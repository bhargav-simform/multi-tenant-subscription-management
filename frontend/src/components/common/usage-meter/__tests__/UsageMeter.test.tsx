import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UsageMeter } from '@/components/common/usage-meter';

describe('UsageMeter', () => {
    it('exposes the raw numbers via an accessible progressbar', () => {
        render(<UsageMeter label="Seats" used={2} max={5} />);
        const bar = screen.getByRole('progressbar', { name: 'Seats' });
        expect(bar).toHaveAttribute('aria-valuenow', '40');
        expect(bar).toHaveAttribute('aria-valuetext', '2 of 5 used');
    });

    it('never divides by zero when max is 0 — treated as full', () => {
        render(<UsageMeter label="Storage" used={0} max={0} />);
        const bar = screen.getByRole('progressbar', { name: 'Storage' });
        expect(bar).toHaveAttribute('aria-valuenow', '100');
    });

    it('caps the visual percentage at 100 even if used exceeds max', () => {
        render(<UsageMeter label="Seats" used={9} max={5} />);
        const bar = screen.getByRole('progressbar', { name: 'Seats' });
        expect(bar).toHaveAttribute('aria-valuenow', '100');
    });

    it('formats used/max through a custom formatter when given one', () => {
        render(<UsageMeter label="Storage" used={1024} max={2048} format={(v) => `${v}b`} />);
        expect(screen.getByText('1024b of 2048b used')).toBeInTheDocument();
    });
});
