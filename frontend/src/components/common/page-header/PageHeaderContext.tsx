import { createContext, useContext, useEffect } from 'react';

interface PageHeaderContextValue {
    setTitle: (title: string | undefined) => void;
    setSearchPlaceholder: (placeholder: string | undefined) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue | null>(null);

export const PageHeaderProvider = PageHeaderContext.Provider;

/**
 * Overrides the layout header's title for pages whose title can't be derived
 * from the matching NavItem's label alone (e.g. a detail page showing a
 * resource's own name). Falls back to the nav-derived label when never called.
 */
export function useSetPageTitle(title: string | undefined) {
    const context = useContext(PageHeaderContext);

    useEffect(() => {
        if (!context) return;
        context.setTitle(title);
        return () => context.setTitle(undefined);
    }, [context, title]);
}

/** Sets the header search bar's placeholder text for the current page — see HeaderSearchInput for why the input itself is presentational-only. */
export function useSetSearchPlaceholder(placeholder: string | undefined) {
    const context = useContext(PageHeaderContext);

    useEffect(() => {
        if (!context) return;
        context.setSearchPlaceholder(placeholder);
        return () => context.setSearchPlaceholder(undefined);
    }, [context, placeholder]);
}
