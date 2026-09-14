import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationRepository } from './organization.repository';
import { ORGANIZATION_REPOSITORY } from './organization.repository.interface';

@Module({
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    { provide: ORGANIZATION_REPOSITORY, useClass: OrganizationRepository },
  ],
  exports: [ORGANIZATION_REPOSITORY, OrganizationsService],
})
export class OrganizationsModule {}
