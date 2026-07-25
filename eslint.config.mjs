import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

// eslint-config-next 16 ships flat configs, so they are spread directly — routing them
// through FlatCompat throws on a circular plugin reference.
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'src/generated/**', 'coverage/**'],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // project.md: no `any` without a comment explaining why.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]

export default config
