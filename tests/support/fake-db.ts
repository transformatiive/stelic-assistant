import type { PrismaClient } from '@/generated/prisma/client'

/**
 * A small in-memory stand-in for the three tables the auth layer touches.
 *
 * Not a Prisma emulator — it implements exactly the calls `store.ts` and `token-sources.ts`
 * make, and nothing else. The point is to test the rules (who gets revoked, what gets
 * cleared, when the expiry slides) without a Postgres container in CI.
 */

export type UserRow = {
  id: string
  zohoUserId: string | null
  zohoProjectsUserId: string | null
  crmUserId: string | null
  email: string
  displayName: string | null
  timezone: string
  isActive: boolean
  createdAt: Date
  lastSeenAt: Date | null
}

export type TokenRow = {
  userId: string
  refreshTokenEncrypted: string
  accessTokenEncrypted: string | null
  accessTokenExpiresAt: Date | null
  scope: string | null
}

export type SessionRow = {
  id: string
  userId: string
  userAgent: string | null
  ipHash: string | null
  createdAt: Date
  lastUsedAt: Date
  expiresAt: Date
  revokedAt: Date | null
}

export type ProjectIndexRow = {
  userId: string
  projectId: string
  projectName: string
  projectIdString: string | null
  crmDealId: string | null
  dealName: string | null
  accountName: string | null
  aliases: string[]
  chargeCodes: unknown
  lastLoggedAt: Date | null
  refreshedAt: Date
}

export type CommitLogRow = {
  userId: string
  projectId: string
  status: string
  logDate: Date
}

export type ServiceTokenRow = {
  id: string
  accessTokenEncrypted: string
  expiresAt: Date
}

export class FakeDb {
  users: UserRow[] = []
  tokens: TokenRow[] = []
  sessions: SessionRow[] = []
  serviceTokens: ServiceTokenRow[] = []
  projectIndexes: ProjectIndexRow[] = []
  commitLogs: CommitLogRow[] = []
  private nextId = 1

  seedUser(overrides: Partial<UserRow> = {}): UserRow {
    const row: UserRow = {
      id: `user_${this.nextId++}`,
      zohoUserId: '917530087',
      zohoProjectsUserId: '917530087',
      crmUserId: null,
      email: 'nuno@stelic.com',
      displayName: 'Nuno Barreto',
      timezone: 'America/New_York',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: null,
      ...overrides,
    }
    this.users.push(row)
    return row
  }

  seedSession(overrides: Partial<SessionRow> & { userId: string }): SessionRow {
    const row: SessionRow = {
      id: `sess_${this.nextId++}`,
      userAgent: null,
      ipHash: null,
      createdAt: new Date('2026-07-01T00:00:00Z'),
      lastUsedAt: new Date('2026-07-01T00:00:00Z'),
      expiresAt: new Date('2026-08-30T00:00:00Z'),
      revokedAt: null,
      ...overrides,
    }
    this.sessions.push(row)
    return row
  }

  seedToken(overrides: Partial<TokenRow> & { userId: string }): TokenRow {
    const row: TokenRow = {
      refreshTokenEncrypted: '',
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      scope: null,
      ...overrides,
    }
    this.tokens.push(row)
    return row
  }

  /** Cast at the single boundary, so the production code stays typed against Prisma. */
  get client(): PrismaClient {
    return this as unknown as PrismaClient
  }

  readonly user = {
    findUnique: async ({ where }: { where: { zohoUserId?: string; email?: string } }) =>
      this.users.find(
        (u) =>
          (where.zohoUserId !== undefined && u.zohoUserId === where.zohoUserId) ||
          (where.email !== undefined && u.email === where.email),
      ) ?? null,

    create: async ({ data }: { data: Partial<UserRow> }) => {
      const row = this.seedUser({
        ...data,
        id: `user_${this.nextId++}`,
      } as Partial<UserRow>)
      return { id: row.id }
    },

    update: async ({
      where,
      data,
    }: {
      where: { id: string }
      data: Partial<UserRow>
    }) => {
      const row = this.users.find((u) => u.id === where.id)!
      Object.assign(row, data)
      return { id: row.id }
    },
  }

  readonly oAuthToken = {
    findUnique: async ({ where }: { where: { userId: string } }) =>
      this.tokens.find((t) => t.userId === where.userId) ?? null,

    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId: string }
      create: TokenRow
      update: Partial<TokenRow>
    }) => {
      const existing = this.tokens.find((t) => t.userId === where.userId)
      if (existing) Object.assign(existing, update)
      else this.tokens.push({ ...create })
      return {}
    },

    deleteMany: async ({ where }: { where: { userId: string } }) => {
      this.tokens = this.tokens.filter((t) => t.userId !== where.userId)
      return { count: 0 }
    },
  }

  readonly session = {
    create: async ({ data }: { data: SessionRow }) => {
      this.sessions.push({ ...data })
      return data
    },

    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.sessions.find((s) => s.id === where.id)
      if (!row) return null
      return { ...row, user: this.users.find((u) => u.id === row.userId) ?? null }
    },

    update: async ({
      where,
      data,
    }: {
      where: { id: string }
      data: Partial<SessionRow>
    }) => {
      const row = this.sessions.find((s) => s.id === where.id)!
      Object.assign(row, data)
      return row
    },

    updateMany: async ({
      where,
      data,
    }: {
      where: { id?: string; userId?: string; revokedAt?: null }
      data: Partial<SessionRow>
    }) => {
      const matched = this.sessions.filter(
        (s) =>
          (where.id === undefined || s.id === where.id) &&
          (where.userId === undefined || s.userId === where.userId) &&
          (where.revokedAt !== null || s.revokedAt === null),
      )
      matched.forEach((s) => Object.assign(s, data))
      return { count: matched.length }
    },

    count: async ({
      where,
    }: {
      where: {
        userId: string
        id?: { not: string }
        revokedAt?: null
        expiresAt?: { gt: Date }
      }
    }) =>
      this.sessions.filter(
        (s) =>
          s.userId === where.userId &&
          (where.id === undefined || s.id !== where.id.not) &&
          (where.revokedAt !== null || s.revokedAt === null) &&
          (where.expiresAt === undefined || s.expiresAt > where.expiresAt.gt),
      ).length,
  }

  readonly projectIndex = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId_projectId: { userId: string; projectId: string } }
      create: ProjectIndexRow
      update: Partial<ProjectIndexRow>
    }) => {
      const { userId, projectId } = where.userId_projectId
      const existing = this.projectIndexes.find(
        (r) => r.userId === userId && r.projectId === projectId,
      )
      if (existing) Object.assign(existing, update)
      else
        this.projectIndexes.push({ ...create, lastLoggedAt: create.lastLoggedAt ?? null })
      return {}
    },

    deleteMany: async ({
      where,
    }: {
      where: { userId: string; projectId?: { notIn: string[] } }
    }) => {
      const before = this.projectIndexes.length
      this.projectIndexes = this.projectIndexes.filter(
        (r) =>
          r.userId !== where.userId ||
          (where.projectId !== undefined && where.projectId.notIn.includes(r.projectId)),
      )
      return { count: before - this.projectIndexes.length }
    },

    updateMany: async ({
      where,
      data,
    }: {
      where: { userId: string; projectId: string }
      data: Partial<ProjectIndexRow>
    }) => {
      const matched = this.projectIndexes.filter(
        (r) => r.userId === where.userId && r.projectId === where.projectId,
      )
      matched.forEach((r) => Object.assign(r, data))
      return { count: matched.length }
    },

    findMany: async ({ where }: { where: { userId: string } }) =>
      this.projectIndexes.filter((r) => r.userId === where.userId),

    findFirst: async ({ where }: { where: { userId: string } }) =>
      this.projectIndexes
        .filter((r) => r.userId === where.userId)
        .sort((a, b) => b.refreshedAt.getTime() - a.refreshedAt.getTime())[0] ?? null,

    count: async ({ where }: { where: { userId: string } }) =>
      this.projectIndexes.filter((r) => r.userId === where.userId).length,
  }

  readonly commitLog = {
    groupBy: async ({
      where,
    }: {
      where: { userId: string; status: string; logDate: { gte: Date } }
    }) => {
      const matched = this.commitLogs.filter(
        (r) =>
          r.userId === where.userId &&
          r.status === where.status &&
          r.logDate >= where.logDate.gte,
      )
      const byProject = new Map<string, Date>()
      for (const row of matched) {
        const current = byProject.get(row.projectId)
        if (!current || row.logDate > current) byProject.set(row.projectId, row.logDate)
      }
      return [...byProject].map(([projectId, logDate]) => ({
        projectId,
        _max: { logDate },
      }))
    },
  }

  readonly serviceToken = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.serviceTokens.find((t) => t.id === where.id) ?? null,

    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { id: string }
      create: ServiceTokenRow
      update: Partial<ServiceTokenRow>
    }) => {
      const existing = this.serviceTokens.find((t) => t.id === where.id)
      if (existing) Object.assign(existing, update)
      else this.serviceTokens.push({ ...create })
      return {}
    },
  }
}
