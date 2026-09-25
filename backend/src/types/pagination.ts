/**
 * Keyset (cursor) pagination — never OFFSET. Every list endpoint uses this shape so
 * the frontend's pagination component is written once.
 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
