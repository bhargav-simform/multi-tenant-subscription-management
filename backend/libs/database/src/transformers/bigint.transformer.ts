import type { ValueTransformer } from 'typeorm';

/**
 * §15.1: TypeORM's pg driver returns `bigint` columns as JavaScript strings
 * to avoid silent precision loss for values beyond Number.MAX_SAFE_INTEGER —
 * regardless of what the entity's TypeScript type annotation claims. A field
 * typed `number` over a `bigint` column is a compile-time fiction `tsc`
 * cannot catch: arithmetic on it silently becomes string concatenation
 * ("1000000" + 500 === "1000000500"), and comparisons become lexicographic
 * ("9000000000" > "10000000000" === true). This transformer makes the JS
 * side genuinely a `number`, at the accepted cost of precision above 2^53 —
 * acceptable here because every bigint column in this system is a byte
 * count (`used_storage_bytes`, `max_storage_bytes`), and 2^53 bytes is far
 * beyond any quota this POC models.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};
