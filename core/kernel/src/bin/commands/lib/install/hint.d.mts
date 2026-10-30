export interface PackageIndex { common?: Record<string, { package?: string, provided?: string, meta?: boolean }>, commands?: Record<string, string> }
export function providerOf(index: PackageIndex | undefined, name: string): { command: string, package: string, provider?: string, meta: boolean } | undefined
export function hintFor(index: PackageIndex | undefined, name: string, options?: { root?: boolean }): string | undefined
