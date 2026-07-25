import { defineConfig } from 'prisma/config'

// Prisma 7 moved the connection URL out of schema.prisma. The URL is only ever read from
// the environment — never committed, never fetched from the vault at runtime (design.md §7).
//
// `datasource.url` is only needed by the commands that talk to a database — `migrate`,
// `db push`, `introspect`. `prisma generate` does not, and it runs during the container
// build, where Railway does not inject service variables. Declaring the URL unconditionally
// (via prisma's `env()` helper, which throws when the variable is absent) therefore failed
// every build with `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`.
//
// So the datasource is attached only when the URL is actually present: generate works in a
// bare build environment, and migrate still gets what it needs at deploy and dev time.
const databaseUrl = process.env.DATABASE_URL

export default defineConfig({
  schema: 'prisma/schema.prisma',
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
  migrations: {
    path: 'prisma/migrations',
  },
})
