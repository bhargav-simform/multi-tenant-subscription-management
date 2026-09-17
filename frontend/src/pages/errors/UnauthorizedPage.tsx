import { Link } from 'react-router-dom';

import { PageNotFoundState } from '@/components/common/page-state';
import { Button } from '@/components/ui/button';
import { LABELS } from '@/constants/labels';
import { ROUTES } from '@/constants/routes';
import { useAuth } from '@/contexts/useAuth';

export default function UnauthorizedPage() {
    const { isPlatformAdmin } = useAuth();
    const home = isPlatformAdmin ? ROUTES.ADMIN_ORGANIZATIONS : ROUTES.DASHBOARD;

    return (
        <div className="flex min-h-svh items-center justify-center p-6">
            <PageNotFoundState
                title={LABELS.ERRORS.UNAUTHORIZED_TITLE}
                body={LABELS.ERRORS.UNAUTHORIZED_BODY}
                action={
                    <Button variant="outline" size="sm" asChild>
                        <Link to={home}>{LABELS.ERRORS.BACK_HOME}</Link>
                    </Button>
                }
            />
        </div>
    );
}
