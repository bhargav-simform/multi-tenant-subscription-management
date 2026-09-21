import { z } from 'zod';

const BYTES_PER_MB = 1024 * 1024;

/** MB, rounded, is what the form collects — bytesToMb/mbToBytes convert at the form's edge. */
export const bytesToMb = (bytes: number): number => Math.round((bytes / BYTES_PER_MB) * 100) / 100;
export const mbToBytes = (mb: number): number => Math.round(mb * BYTES_PER_MB);

/**
 * resource-service CreateResourceDto: @IsString @MaxLength(255) name,
 * @IsOptional @IsString description, @IsInt @Min(0) sizeBytes.
 *
 * The form collects `sizeMb`, not `sizeBytes` — typing "4000000" to mean 4 MB
 * is not a size any real person thinks in. `sizeMb` is converted to
 * `sizeBytes` at the API call boundary (mbToBytes, in ResourceFormDialog),
 * never sent to the server as-is. `sizeBytes` is still what's validated as
 * non-negative here, one step after conversion — the resolver validates the
 * schema shape below, but the boundary conversion happens after `handleSubmit`
 * resolves, so this schema itself has no bytes field to validate on submit.
 */
export const createResourceSchema = z.object({
    name: z.string().trim().min(1, 'Enter a name.').max(255, 'Name must be at most 255 characters.'),
    description: z.string().trim().max(2000, 'Description is too long.').optional(),
    sizeMb: z
        .number({ message: 'Enter a size in MB.' })
        .min(0, 'Size cannot be negative.'),
});

export type CreateResourceFormValues = z.infer<typeof createResourceSchema>;
