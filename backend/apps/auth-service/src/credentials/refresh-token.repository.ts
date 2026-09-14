import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { RefreshToken } from './refresh-token.entity';
import type { IRefreshTokenRepository } from './refresh-token.repository.interface';

/** Raw DataSource — see credential.repository.ts; same REGISTRY_TABLES reasoning. */
@Injectable()
export class RefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findByTokenHash(
    tokenHash: string,
    manager?: EntityManager,
  ): Promise<RefreshToken | null> {
    const repo = (manager ?? this.dataSource.manager).getRepository(RefreshToken);
    return repo.findOne({ where: { tokenHash } });
  }

  async create(
    data: { credentialId: string; tokenHash: string; expiresAt: Date },
    manager: EntityManager,
  ): Promise<RefreshToken> {
    const repo = manager.getRepository(RefreshToken);
    return repo.save(repo.create(data));
  }

  async markReplaced(id: string, replacedById: string, manager: EntityManager): Promise<void> {
    const repo = manager.getRepository(RefreshToken);
    await repo.update({ id }, { replacedBy: replacedById, revokedAt: new Date() });
  }

  async revokeAllForCredential(credentialId: string, manager: EntityManager): Promise<void> {
    const repo = manager.getRepository(RefreshToken);
    await repo.update({ credentialId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async revoke(id: string, manager?: EntityManager): Promise<void> {
    const repo = (manager ?? this.dataSource.manager).getRepository(RefreshToken);
    await repo.update({ id }, { revokedAt: new Date() });
  }
}
