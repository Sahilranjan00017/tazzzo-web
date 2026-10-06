import 'server-only'

/** Current time for server-rendered "as of page load" derivations (kept out of components so renders stay pure). */
export const serverNow = (): number => Date.now()
