/**
 * Keyset cursors: base64url("<sortValue>|<id>"). The sort value is an ISO timestamp
 * or a number; the id is the tiebreaker, so the (value, id) pair is unique.
 */
export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(`${sortValue}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): [string, string] {
  const [sortValue, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return [sortValue, id];
}
