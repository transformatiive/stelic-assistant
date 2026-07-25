import { defineConfig, env } from 'prisma/config'

// Prisma 7 moved the connection URL out of schema.prisma. The URL is only ever read from
// the environment — never committed, never fetched from the vault at runtime (design.md §7).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
  },
})
