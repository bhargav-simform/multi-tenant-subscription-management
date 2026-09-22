import { hashPick } from '@/lib/hashSeed';
import { cn } from '@/lib/utils';

const AVATAR_TONES = ['purple', 'peach', 'blue', 'mint', 'teal', 'gold'] as const;
type AvatarTone = (typeof AVATAR_TONES)[number];

const TONE_CLASS: Record<AvatarTone, string> = {
    purple: 'bg-tile-purple-bg text-tile-purple-fg',
    peach: 'bg-tile-peach-bg text-tile-peach-fg',
    blue: 'bg-tile-blue-bg text-tile-blue-fg',
    mint: 'bg-tile-mint-bg text-tile-mint-fg',
    teal: 'bg-tile-teal-bg text-tile-teal-fg',
    gold: 'bg-tile-gold-bg text-tile-gold-fg',
};

export interface AvatarProps {
    /** Stable identity to hash for color assignment — a user id or email. */
    seed: string;
    initials: string;
    size?: 'sm' | 'md';
    className?: string;
}

/** A circular initials avatar whose color is a deterministic function of `seed` — the same user always gets the same color. */
export function Avatar({ seed, initials, size = 'md', className }: AvatarProps) {
    const tone = hashPick(seed, AVATAR_TONES);
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
                size === 'sm' ? 'size-7 text-xs' : 'size-8 text-xs',
                TONE_CLASS[tone],
                className,
            )}
        >
            {initials}
        </span>
    );
}
