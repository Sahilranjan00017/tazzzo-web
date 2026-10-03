import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const SERVER_IMPORT_BAN = {
  patterns: [
    {
      group: ['@/server', '@/server/*', '**/server/*'],
      message:
        'src/server/* is server-only (secrets, env). Client-safe code (components, lib) must not import it.',
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
      // Identity/tokens never live in browser storage; the CMS session will be an HttpOnly cookie (W2).
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'No browser storage for identity, tokens or roles.' },
        { name: 'sessionStorage', message: 'No browser storage for identity, tokens or roles.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'localStorage', message: 'No browser storage for identity.' },
        {
          object: 'window',
          property: 'sessionStorage',
          message: 'No browser storage for identity.',
        },
        {
          object: 'document',
          property: 'cookie',
          message: 'Cookies are server-managed (HttpOnly).',
        },
      ],
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
