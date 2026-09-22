import { useState } from 'react';
import { SearchIcon } from 'lucide-react';

export interface HeaderSearchInputProps {
    placeholder: string;
}

/**
 * UI only. No backend search endpoint exists for resources/users — every list
 * DTO (e.g. backend/apps/resource-service/src/resources/dto/
 * list-resources-query.dto.ts) accepts only cursor+limit, no search/q param.
 * Do not wire this to client-side filtering of the current page: every list it
 * would front is server-paginated, so filtering only fetched rows would
 * silently hide matches sitting on pages the caller hasn't loaded yet. The
 * local state below exists only so the input is visibly interactive, not to
 * back any real query.
 */
export function HeaderSearchInput({ placeholder }: HeaderSearchInputProps) {
    const [value, setValue] = useState('');

    return (
        <div className="relative w-72 max-w-full">
            <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
                type="search"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={placeholder}
                aria-label={placeholder}
                className="h-9 w-full rounded-full border border-border bg-white pr-4 pl-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
        </div>
    );
}
