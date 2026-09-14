/**
 * Keyset (cursor) pagination — never OFFSET (§29). Every list endpoint in every
 * service uses this shape so the frontend's pagination component is written once.
 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CursorQuery {
  cursor?: string;
  limit?: number;
}
