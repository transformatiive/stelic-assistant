import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'

// Prisma 7 takes the connection through a driver adapter rather than a schema datasource url.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient()
  }
  return globalForPrisma.prisma
}

/**
 * The client is created on first *use*, not on import.
 *
 * `next build` imports every route module to collect page data, in an environment that has no
 * `DATABASE_URL` — Railway injects service variables at runtime, not at build. Constructing
 * eagerly failed the build with "DATABASE_URL is not set" the moment a route first imported
 * this module. A proxy keeps the ergonomic `prisma.user.findUnique(...)` call site while
 * deferring the connection to the first query.
 *
 * One client per process; in dev it survives hot reloads instead of exhausting connections.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(getClient(), property, receiver)
  },
  has: (_target, property) => property in getClient(),
})
