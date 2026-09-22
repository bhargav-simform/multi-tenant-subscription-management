import { FileIcon, FileTextIcon, ImageIcon } from 'lucide-react';

import { resolveFileTypeTile, type TileTone } from '@/lib/fileTypeTile';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<TileTone, string> = {
    purple: 'bg-tile-purple-bg text-tile-purple-fg',
    peach: 'bg-tile-peach-bg text-tile-peach-fg',
    blue: 'bg-tile-blue-bg text-tile-blue-fg',
    mint: 'bg-tile-mint-bg text-tile-mint-fg',
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'txt', 'md']);

export interface FileTypeTileProps {
    resource: { name: string; id: string };
    className?: string;
}

/** A rounded-square, pastel-colored file-type tile — color and icon derived deterministically from the resource's extension. */
export function FileTypeTile({ resource, className }: FileTypeTileProps) {
    const tone = resolveFileTypeTile(resource);
    const ext = resource.name.split('.').pop()?.toLowerCase();
    const iconProps = { className: 'size-4', 'aria-hidden': true } as const;

    return (
        <span className={cn('inline-flex size-9 shrink-0 items-center justify-center rounded-lg', TONE_CLASS[tone], className)}>
            {ext && IMAGE_EXTENSIONS.has(ext) ? (
                <ImageIcon {...iconProps} />
            ) : ext && DOCUMENT_EXTENSIONS.has(ext) ? (
                <FileTextIcon {...iconProps} />
            ) : (
                <FileIcon {...iconProps} />
            )}
        </span>
    );
}
