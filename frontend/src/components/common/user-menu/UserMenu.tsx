import { LogOutIcon } from 'lucide-react';

import { Avatar } from '@/components/common/avatar';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useAuth } from '@/contexts/useAuth';
import { useLogout } from '@/hooks/auth/mutations';

export function UserMenu() {
    const { user, isPlatformAdmin, isOrgAdmin } = useAuth();
    const { mutate: logout, isPending } = useLogout();

    if (!user) return null;

    const initials = user.email.slice(0, 2).toUpperCase();
    const roleLabel = isPlatformAdmin
        ? LABELS.ADMIN.TITLE
        : isOrgAdmin
          ? LABELS.USERS.ROLE_ORG_ADMIN
          : LABELS.USERS.ROLE_ORG_MEMBER;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" aria-label={user.email}>
                    <Avatar seed={user.email} initials={initials} />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{user.email}</span>
                    <span className="text-xs font-normal text-muted-foreground">{roleLabel}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    disabled={isPending}
                    onSelect={() => {
                        // A hard navigation after sign-out guarantees no stale screen
                        // survives the cache clear.
                        logout(undefined, { onSettled: () => globalThis.location.assign(ROUTES.LOGIN) });
                    }}
                >
                    <LogOutIcon className="size-4" />
                    {LABELS.AUTH.SIGN_OUT}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
