import { parseEnv } from 'node:util'

/** Deliberately bounded subset shared by Host discovery and the sandbox. Native
 * python-dotenv also accepts quoted keys and multiline forms; accepting those
 * without exactly matching its parser could change the pinned account home. */
export function parseHermesOwnEnvironment(source: string): Record<string, string> {
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (!/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line))
      throw new Error('Hermes .env 格式无法安全读取，请使用普通 KEY=value 配置')
  }
  const result = Object.fromEntries(
    Object.entries(parseEnv(source)).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  // An empty assignment also overrides the process value and re-enables native
  // global fallback. Check presence, never truthiness, for every selector.
  for (const key of ['HOME', 'HERMES_HOME', 'HERMES_PROFILE', 'HERMES_MANAGED_DIR'])
    if (Object.hasOwn(result, key)) throw new Error('Hermes 账号环境不能重定向账号目录')
  if (Object.values(result).some((value) => value.includes('${')))
    throw new Error('Hermes .env 暂不支持环境变量插值')
  return result
}
