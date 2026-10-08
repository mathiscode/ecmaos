/**
 * Programs run in workers and wait on a `SharedArrayBuffer`, which a browser gives only to a page that is
 * cross-origin isolated. Without it the first program to start fails deep inside the kernel with a message about
 * a missing `SharedArrayBuffer`, so boot checks first and says what to change.
 */

export interface IsolationEnvironment {
  /** `undefined` where the platform has no such concept (Node, a test DOM): nothing to check there */
  crossOriginIsolated?: boolean
  isSecureContext?: boolean
}

/** What is wrong with where the page is served from, or `undefined` when programs can run */
export function isolationProblem(env: IsolationEnvironment = globalThis): string | undefined {
  if (env.crossOriginIsolated !== false) return undefined
  const lines = ['This page is not cross-origin isolated, so ecmaOS cannot start programs.']
  if (env.isSecureContext === false) lines.push('It is not a secure context: serve it over https:// (or from localhost).')
  lines.push(
    'Serve every response with these headers:',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Embedder-Policy: require-corp',
    'Ready-made configuration for common hosts is in the hosting/ folder, and `npx ecmaos --serve` serves the site with them.'
  )
  return lines.join('\n')
}
