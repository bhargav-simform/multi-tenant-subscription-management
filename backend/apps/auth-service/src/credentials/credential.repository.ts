import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Credential } from './credential.entity';
import type { ICredentialRepository } from './credential.repository.interface';
import { EmailTakenError } from './email-taken.error';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Raw DataSource, not TenantAwareDataSource — credentials is a REGISTRY table
 * (§8.2, §13.8), not RLS-protected. See credential.entity.ts. Do not copy this
 * pattern for an RLS-protected table in another service.
 */
@Injectable()
export class CredentialRepository implements ICredentialRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findByEmail(email: string, manager?: EntityManager): Promise<Credential | null> {
    const repo = (manager ?? this.dataSource.manager).getRepository(Credential);
    return repo.findOne({ where: { email } });
  }

  async findByUserId(userId: string, manager?: EntityManager): Promise<Credential | null> {
    const repo = (manager ?? this.dataSource.manager).getRepository(Credential);
    return repo.findOne({ where: { userId } });
  }

  async findById(id: string, manager?: EntityManager): Promise<Credential | null> {
    const repo = (manager ?? this.dataSource.manager).getRepository(Credential);
    return repo.findOne({ where: { id } });
  }

  async create(
    data: { userId: string; organizationId: string | null; email: string; passwordHash: string },
    manager: EntityManager,
  ): Promise<Credential> {
    const repo = manager.getRepository(Credential);
    const credential = repo.create(data);
    try {
      return await repo.save(credential);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new EmailTakenError(data.email);
      }
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
