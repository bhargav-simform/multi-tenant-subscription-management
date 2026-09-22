/** Deterministic string hash — same input always yields the same output, never Math.random(). */
export function hashSeed(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + (seed.codePointAt(i) ?? 0)) >>> 0;
    return hash;
}

/** Picks a deterministic element from `values` for the given seed — never returns undefined for a non-empty array. */
export function hashPick<T>(seed: string, values: readonly T[]): T {
    const value = values[hashSeed(seed) % values.length];
    if (value === undefined) throw new Error('hashPick requires a non-empty values array');
    return value;
}
