import { hashPick } from '@/lib/hashSeed';

const TILE_TONES = ['purple', 'peach', 'blue', 'mint'] as const;
export type TileTone = (typeof TILE_TONES)[number];

/**
 * Deterministic tone for a resource's file-type tile — hashes the extension
 * when the name actually has one, otherwise falls back to the resource id, so
 * the same resource always renders the same tile color, never Math.random().
 */
export function resolveFileTypeTile(resource: { name: string; id: string }): TileTone {
    const parts = resource.name.split('.');
    const ext = parts.length > 1 ? parts.pop()?.toLowerCase() : undefined;
    return hashPick(ext ?? resource.id, TILE_TONES);
}
