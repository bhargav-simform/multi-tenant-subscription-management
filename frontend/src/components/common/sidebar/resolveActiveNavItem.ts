import type { NavItem } from './AppSidebar';

/**
 * Finds the nav item whose route best matches the current path, so the layout
 * header can show a title/icon without every page passing one down. Detail
 * routes (e.g. /resources/:id) aren't in the nav arrays, so this matches by
 * longest path prefix rather than requiring an exact match.
 */
export function resolveActiveNavItem(pathname: string, items: NavItem[]): NavItem | undefined {
    return items
        .filter((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))
        .sort((a, b) => b.to.length - a.to.length)[0];
}
