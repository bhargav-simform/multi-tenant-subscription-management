import { z } from 'zod';

/**
 * resource-service CreateResourceDto: @IsString @MaxLength(255) name,
 * @IsOptional @IsString description, @IsInt @Min(0) sizeBytes.
 *
 * `sizeBytes` is what counts against the plan's storage limit, so it is an
 * integer and never negative — a negative size would be a way to inflate the
 * remaining quota, which is why the backend guards it too.
 */
export const createResourceSchema = z.object({
    name: z.string().trim().min(1, 'Enter a name.').max(255, 'Name must be at most 255 characters.'),
    description: z.string().trim().max(2000, 'Description is too long.').optional(),
    sizeBytes: z
        .number({ message: 'Enter a size in bytes.' })
        .int('Size must be a whole number of bytes.')
        .min(0, 'Size cannot be negative.'),
});

export type CreateResourceFormValues = z.infer<typeof createResourceSchema>;
