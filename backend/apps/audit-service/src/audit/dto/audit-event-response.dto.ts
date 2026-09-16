import type { AuditSeverity } from '../audit-severity.enum';

/**
 * §8.7's `GET /audit`, Platform Admin row: "metadata-level events only".
 *
 * THIS IS THE PROJECTION THAT MAKES THAT TRUE, and the base class is the
 * metadata-only one BY CONSTRUCTION — a platform admin gets exactly this
 * object, and the full-payload shape below is what EXTENDS it, not the other
 * way round. Written this way on purpose: if a future field is added to the
 * base, it goes to the platform admin too, which is the direction that requires
 * a deliberate decision. Adding it to the subclass instead is the safe default,
 * and the type system makes the unsafe direction the one you have to type out.
 *
 * `payload` is the field being withheld, and the reason is not isolation but
 * AUTHORIZATION (§12 vs §13): a `ResourceCreated` payload carries a resource
 * NAME, which is organisation content, and §13.6's whole claim is that a
 * platform admin sees organisations and metadata but not their content. RLS
 * cannot express a COLUMN-level distinction — it filters rows, not fields — so
 * this belongs in the service/DTO layer, and is implemented there rather than
 * pretended to be structural.
 *
 * `organizationId` IS included here, unlike every other response DTO in this
 * system (compare ResourceResponseDto, which deliberately omits it): knowing
 * WHICH organisation an event belongs to is the entire content of a
 * platform-admin audit view, and the caller is by definition entitled to the
 * org registry (§13.6, §8.3). It is not leaking a tenant's identity to a
 * tenant — an ORG ADMIN only ever sees their own org's events, so the field is
 * a constant they already know.
 */
export class AuditEventMetadataResponseDto {
  id!: string;
  eventId!: string;
  eventType!: string;
  organizationId!: string | null;
  actorUserId!: string | null;
  correlationId!: string;
  severity!: AuditSeverity;
  occurredAt!: Date;
}

/**
 * §8.7's `GET /audit`, Org Admin row: their OWN organisation's events, in full.
 * The payload is their own organisation's content, so there is nothing to
 * withhold — and withholding it would make the endpoint useless for the
 * "structured trace for onboarding and plan-limit rejections" the brief asks
 * for, since the trace is largely IN the payload.
 */
export class AuditEventResponseDto extends AuditEventMetadataResponseDto {
  payload!: Record<string, unknown>;
}
