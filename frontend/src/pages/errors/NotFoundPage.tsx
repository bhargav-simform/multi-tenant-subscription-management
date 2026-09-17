import { Link } from 'react-router-dom';

import { PageNotFoundState } from '@/components/common/page-state';
import { Button } from '@/components/ui/button';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useAuth } from '@/contexts/useAuth';

export default function NotFoundPage() {
    const { isAuthenticated, isPlatformAdmin } = useAuth();
    const home = !isAuthenticated ? ROUTES.LOGIN : isPlatformAdmin ? ROUTES.ADMIN_ORGANIZATIONS : ROUTES.DASHBOARD;

    return (
        <div className="flex min-h-svh items-center justify-center p-6">
            <PageNotFoundState
                title={LABELS.ERRORS.NOT_FOUND_TITLE}
                body={LABELS.ERRORS.NOT_FOUND_BODY}
                action={
                    <Button variant="outline" size="sm" asChild>
                        <Link to={home}>{LABELS.ERRORS.BACK_HOME}</Link>
                    </Button>
                }
            />
        </div>
    );
}
