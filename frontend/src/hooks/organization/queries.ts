import { useQuery } from '@tanstack/react-query';

import { STALE_TIME } from '@/constants/common';
import { QUERY_KEYS } from '@/constants/queryKeys';
import { organizationsApi } from '@/services/organizations/organizationsApi';

/** The caller's own organisation. No id is passed, because no route accepts one. */
export const useMyOrganization = () =>
    useQuery({
        queryKey: QUERY_KEYS.ORGANIZATION.ME,
        queryFn: () => organizationsApi.getMine(),
        staleTime: STALE_TIME.FIVE_MINUTES,
    });
