import { cn } from '@/lib/utils';

export interface FilterChip {
    id: string;
    label: string;
}

export interface FilterChipGroupProps {
    chips: FilterChip[];
    activeId: string;
    onChange: (id: string) => void;
    className?: string;
}

/**
 * A radiogroup of pill filter chips. Purely presentational — the caller owns
 * what `activeId`/`onChange` actually do. On ResourcesPage each chip maps to a
 * real server-side sort/filter param (resource-service's
 * ListResourcesQueryDto), never a client-side filter over one already-fetched
 * page, since that list is keyset-paginated and filtering only the current
 * page would silently hide matches on pages not yet fetched.
 */
export function FilterChipGroup({ chips, activeId, onChange, className }: FilterChipGroupProps) {
    return (
        <div role="radiogroup" className={cn('flex flex-wrap gap-2', className)}>
            {chips.map((chip) => {
                const isActive = chip.id === activeId;
                return (
                    <button
                        key={chip.id}
                        type="button"
                        role="radio"
                        aria-checked={isActive}
                        onClick={() => onChange(chip.id)}
                        className={cn(
                            'rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-colors outline-none',
                            'focus-visible:ring-2 focus-visible:ring-ring/50',
                            isActive
                                ? 'bg-foreground text-background'
                                : 'border border-border bg-white text-foreground hover:bg-muted',
                        )}
                    >
                        {chip.label}
                    </button>
                );
            })}
        </div>
    );
}
