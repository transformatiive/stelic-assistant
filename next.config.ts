import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Fail the build on a type error rather than shipping one. Linting runs as its own CI
  // step — Next 16 no longer takes an `eslint` block here.
  typescript: { ignoreBuildErrors: false },
  // No Zoho token, OpenRouter key or client secret may reach the browser, so nothing
  // here is exposed via `env` and no NEXT_PUBLIC_ variable carries a credential.
  poweredByHeader: false,
}

export default nextConfig
