import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const SERVER_IMPORT_BAN = {
  patterns: [
    {
      group: ['@/server', '@/server/*', '**/server/*'],
      message:
        'src/server/* is server-only (env, backend access). Client-safe code (components, lib) must not import it.',
    },
  ],
}

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**'] },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Backend text is always rendered as text; never as HTML.
      'react/no-danger': 'error',
    },
  },
  {
    // Client-safe zones: anything a Client Component may import. Server modules are additionally guarded at
    // build time by the `server-only` package.
    files: ['src/components/**', 'src/lib/**'],
    rules: { 'no-restricted-imports': ['error', SERVER_IMPORT_BAN] },
  },
]

export default config
