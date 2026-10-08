const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('Hermes 账号退出记录无法确认，请检查原生账号设置')

/** Native auth.py is_source_suppressed accepts provider-scoped lists and legacy
 * dict keys. Removal retains config values; match the exact native source only. */
export function hermesSourceSuppressed(auth: unknown, provider: string, source: string): boolean {
  if (!record(auth)) throw invalid()
  const suppressed = auth.suppressed_sources
  if (suppressed === undefined) return false
  if (!record(suppressed)) throw invalid()
  const sources = suppressed[provider]
  if (sources === undefined) return false
  if (Array.isArray(sources)) {
    if (sources.some((item) => typeof item !== 'string')) throw invalid()
    return sources.includes(source)
  }
  if (record(sources)) return Object.hasOwn(sources, source)
  throw invalid()
}

/** Safe in-memory view only. Never rewrites native auth, config or environment. */
export function projectHermesUnsuppressedAuth(auth: unknown): Record<string, any> {
  if (!record(auth)) throw invalid()
  if (auth.suppressed_sources !== undefined) {
    if (!record(auth.suppressed_sources)) throw invalid()
    for (const provider of Object.keys(auth.suppressed_sources)) hermesSourceSuppressed(auth, provider, '')
  }
  const providers = { ...(record(auth.providers) ? auth.providers : {}) }
  // Exact seed keys in native credential_pool._seed_from_singletons.
  for (const [provider, source] of [
    ['nous', 'device_code'],
    ['openai-codex', 'device_code'],
    ['xai-oauth', 'device_code'],
    ['minimax-oauth', 'oauth'],
  ] as const)
    if (hermesSourceSuppressed(auth, provider, source)) delete providers[provider]
  const pool = auth.credential_pool
  if (pool !== undefined && !record(pool)) throw invalid()
  return {
    ...auth,
    providers,
    ...(pool === undefined
      ? {}
      : {
          credential_pool: Object.fromEntries(
            Object.entries(pool).map(([provider, entries]) => {
              if (!Array.isArray(entries)) throw invalid()
              return [
                provider,
                entries.filter(
                  (entry) =>
                    !record(entry) || !hermesSourceSuppressed(auth, provider, entry.source ?? 'manual'),
                ),
              ]
            }),
          ),
        }),
  }
}

/** Only the selected provider's env:<NAME> record controls that provider's key. */
export function hermesUnsuppressedEnvironment(
  auth: unknown,
  env: Record<string, string>,
  provider: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !hermesSourceSuppressed(auth, provider, `env:${name}`)),
  )
}
