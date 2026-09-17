import { useCallback, useState } from 'react';

/**
 * Keyset cursor paging, forwards and backwards.
 *
 * The server hands back a `nextCursor` and nothing else — there is no "previous
 * cursor" in a keyset scheme. Going back is therefore done by remembering the
 * cursors already visited in a stack, which costs one array and keeps the server
 * free of the COUNT that page numbers would require.
 */
export function useCursorPagination() {
    const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
    const [index, setIndex] = useState(0);

    const cursor = cursorStack[index];

    const goNext = useCallback(
        (nextCursor: string | null | undefined) => {
            if (!nextCursor) return;
            setCursorStack((stack) => {
                const truncated = stack.slice(0, index + 1);
                return [...truncated, nextCursor];
            });
            setIndex((i) => i + 1);
        },
        [index],
    );

    const goPrevious = useCallback(() => {
        setIndex((i) => Math.max(0, i - 1));
    }, []);

    /** After a mutation changes the list, paging restarts from the first page. */
    const reset = useCallback(() => {
        setCursorStack([undefined]);
        setIndex(0);
    }, []);

    return {
        cursor,
        canGoPrevious: index > 0,
        goNext,
        goPrevious,
        reset,
    };
}
