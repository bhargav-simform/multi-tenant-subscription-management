/**
 * §8.5, R9: platform-admin aggregates. Integers only — there is no shape of
 * this response that could carry organisation content, which is what makes
 * R9's "platform admin sees usage but no content" boundary structural rather
 * than a filter someone has to remember.
 */
export class UsageAggregateResponseDto {
  organizationId!: string;
  planCode!: string;
  usedSeats!: number;
  maxSeats!: number;
  usedStorageBytes!: number;
  maxStorageBytes!: number;
}
