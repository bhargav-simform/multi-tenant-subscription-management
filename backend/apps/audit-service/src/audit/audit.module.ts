import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditEventRepository, SecurityEventRepository } from './audit-record.repository';
import {
  AUDIT_EVENT_REPOSITORY,
  SECURITY_EVENT_REPOSITORY,
} from './audit-record.repository.interface';

/**
 * §20.2: both repositories are bound to their INTERFACE tokens, never injected
 * as concrete classes — AuditService depends on IAuditEventRepository /
 * ISecurityEventRepository and knows nothing about TypeORM.
 *
 * Both tokens are exported because EventsModule's five consumers write through
 * them (§8.7: the consumers are the only writers in this service).
 */
@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    { provide: AUDIT_EVENT_REPOSITORY, useClass: AuditEventRepository },
    { provide: SECURITY_EVENT_REPOSITORY, useClass: SecurityEventRepository },
  ],
  exports: [AUDIT_EVENT_REPOSITORY, SECURITY_EVENT_REPOSITORY, AuditService],
})
export class AuditModule {}
