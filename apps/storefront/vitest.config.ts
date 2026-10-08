import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  // `server-only` throws outside a React Server Components build; tests import server modules directly.
  'server-only': fileURLToPath(new URL('./tests/support/server-only.ts', import.meta.url)),
}

export default defineConfig({
  resolve: { alias },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    projects: [
      {
        resolve: { alias },
        oxc: { jsx: { runtime: 'automatic' } },
        test: { name: 'unit', environment: 'node', include: ['tests/unit/**/*.test.{ts,tsx}'] },
      },
      {
        resolve: { alias },
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'component',
          environment: 'jsdom',
          include: ['tests/component/**/*.test.tsx'],
          setupFiles: ['tests/support/component-setup.ts'],
        },
      },
    ],
  },
})
