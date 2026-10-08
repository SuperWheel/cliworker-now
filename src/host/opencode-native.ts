import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { safePiOmpAncestors } from './pi-omp-native.ts'
import type { AccountIdentity } from './account-identity.ts'

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
export interface OpenCodeNativeOptions {
  nativeHome?: string
  modelsPath?: string
  signal?: AbortSignal
}
export interface OpenCodeNativeProfile {
  sourceIds: string[]
  auth: Record<string, any>
  providers: Record<string, any>
  catalog: Record<string, any>
  modelsPath: string
  enabled?: string[]
  disabled: string[]
}
/** JSONC comments/trailing commas, without changing quoted model IDs or URLs. */
function jsonc(raw: string): unknown {
  let result = '',
    quoted = false,
    escaped = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (quoted) {
      result += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') {
      quoted = true
      result += ch
      continue
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i + 1 < raw.length && raw[i + 1] !== '\n') i++
      continue
    }
    if (ch === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2)
      if (end < 0) throw new Error('Invalid native JSONC')
      i = end + 1
      result += ' '
      continue
    }
    if (ch === ',') {
      let next = i + 1
      while (next < raw.length) {
        if (/\s/.test(raw[next]!)) {
          next++
          continue
        }
        if (raw.slice(next, next + 2) === '//') {
          const line = raw.indexOf('\n', next + 2)
          next = line < 0 ? raw.length : line + 1
          continue
        }
        if (raw.slice(next, next + 2) === '/*') {
          const end = raw.indexOf('*/', next + 2)
          if (end < 0) throw new Error('Invalid native JSONC')
          next = end + 2
          continue
        }
        break
      }
      if (raw[next] === '}' || raw[next] === ']') continue
    }
    result += ch
  }
  return JSON.parse(result)
}
interface ReferenceScope {
  roots: string[]
  env: Record<string, string>
}
async function ownEnvironment(roots: string[], options: OpenCodeNativeOptions, sourceIds: Set<string>) {
  const result: Record<string, string> = {}
  for (const root of roots) {
    let handle
    try {
      options.signal?.throwIfAborted()
      await safePiOmpAncestors(root)
      handle = await open(
        join(root, '.env'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw new Error()
      const bytes = Buffer.alloc(65537)
      try {
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (bytesRead > 65536) throw new Error()
        for (const line of bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)) {
          if (!line.trim() || line.trimStart().startsWith('#')) continue
          const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim())
          if (!match) throw new Error()
          let value = match[2]!
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
          )
            value = value.slice(1, -1)
          if (/`|\$\(|\x00/.test(value)) throw new Error()
          result[match[1]!] = value
          sourceIds.add(resolve(root))
        }
      } finally {
        bytes.fill(0)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('OpenCode 自身环境配置无法安全读取')
    } finally {
      await handle?.close()
    }
  }
  return result
}
async function resolveReferences(
  value: unknown,
  options: OpenCodeNativeOptions,
  scope: ReferenceScope,
  depth = 0,
): Promise<any> {
  if (depth > 48) throw new Error('OpenCode 原生配置过深')
  if (Array.isArray(value))
    return Promise.all(value.map((entry) => resolveReferences(entry, options, scope, depth + 1)))
  if (object(value))
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [
          key,
          await resolveReferences(entry, options, scope, depth + 1),
        ]),
      ),
    )
  if (typeof value !== 'string') return value
  let result = value.replace(/\{env:([^}]+)\}/g, (_, name) => scope.env[name] ?? '')
  for (const match of [...result.matchAll(/\{file:([^}]+)\}/g)]) {
    const path = match[1]!.startsWith('~/')
      ? join(options.nativeHome ?? homedir(), match[1]!.slice(2))
      : match[1]!
    if (
      !isAbsolute(path) ||
      !scope.roots.some((root) => {
        const rel = relative(resolve(root), resolve(path))
        return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
      })
    )
      throw new Error('OpenCode 只允许引用自身账号目录中的凭据文件')
    await safePiOmpAncestors(dirname(path))
    let file: Awaited<ReturnType<typeof open>> | undefined
    const bytes = Buffer.alloc(65537)
    try {
      options.signal?.throwIfAborted()
      const parent = await lstat(dirname(path))
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe credential reference')
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536)
        throw new Error('Unsafe credential reference')
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 65536) throw new Error('Oversized credential reference')
      result = result.replace(match[0], bytes.subarray(0, bytesRead).toString('utf8').trim())
    } catch {
      throw new Error('OpenCode 原生凭据引用无法安全读取')
    } finally {
      bytes.fill(0)
      await file?.close()
    }
  }
  return result
}
function merge(base: Record<string, any>, next: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(next)])].map((key) => [
      key,
      object(base[key]) && object(next[key])
        ? merge(base[key], next[key])
        : next[key] === undefined
          ? base[key]
          : next[key],
    ]),
  )
}
async function readDocument(
  path: string,
  optional: boolean,
  options: OpenCodeNativeOptions,
  comments = false,
  limit = 4 * 1024 * 1024,
): Promise<Record<string, any> | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  const bytes = Buffer.alloc(limit + 1)
  try {
    options.signal?.throwIfAborted()
    const parent = await lstat(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe native account directory')
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size >= bytes.length)
      throw new Error('Unsafe native account file')
    let length = 0
    while (length < bytes.length) {
      options.signal?.throwIfAborted()
      const part = await file.read(bytes, length, bytes.length - length, null)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    const after = await file.stat()
    if (length >= bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('Native account changed during read')
    const value: unknown = comments
      ? jsonc(bytes.subarray(0, length).toString('utf8'))
      : JSON.parse(bytes.subarray(0, length).toString('utf8'))
    if (!object(value)) throw new Error('Invalid native account data')
    return value
  } catch (error) {
    options.signal?.throwIfAborted()
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('OpenCode 原生账号或模型配置无法安全读取，请检查配置')
  } finally {
    bytes.fill(0)
    await file?.close()
  }
}
export const activeOpenCodeCredential = (value: unknown): value is Record<string, any> =>
  object(value) &&
  (value.type === 'api'
    ? text(value.key)
    : value.type === 'oauth' &&
      text(value.access) &&
      typeof value.expires === 'number' &&
      value.expires > Date.now() + 30000)
/** The same native+plugin sources supply metadata queries and worker execution. */
export async function readOpenCodeProfile(
  authDirectory: string,
  options: OpenCodeNativeOptions = {},
): Promise<OpenCodeNativeProfile> {
  const home = options.nativeHome ?? homedir()
  const data = options.nativeHome
    ? join(home, '.local/share')
    : process.env.XDG_DATA_HOME || join(home, '.local/share')
  const config = options.nativeHome
    ? join(home, '.config')
    : process.env.XDG_CONFIG_HOME || join(home, '.config')
  const ownRoots = [
    join(config, 'opencode'),
    join(data, 'opencode'),
    join(dirname(authDirectory), 'config', 'opencode'),
    join(authDirectory, 'opencode'),
  ]
  const sourceIds = new Set<string>()
  const ownEnv = await ownEnvironment(ownRoots, options, sourceIds)
  const globalAuth = (await readDocument(join(data, 'opencode/auth.json'), true, options)) ?? {}
  const localAuth = (await readDocument(join(authDirectory, 'opencode/auth.json'), true, options)) ?? {}
  if (Object.keys(globalAuth).length) sourceIds.add(resolve(data, 'opencode'))
  if (Object.keys(localAuth).length) sourceIds.add(resolve(authDirectory, 'opencode'))
  let settings: Record<string, any> = {}
  const paths = [
    ...['config.json', 'opencode.json', 'opencode.jsonc'].map((name) => join(config, 'opencode', name)),
    ...['opencode.json', 'opencode.jsonc'].map((name) =>
      join(dirname(authDirectory), 'config', 'opencode', name),
    ),
  ]
  for (const path of new Set(paths)) {
    const document = (await readDocument(path, true, options, true)) ?? {}
    settings = merge(settings, document)
    if (Object.keys(document.provider ?? {}).length) sourceIds.add(resolve(dirname(path)))
  }
  const providers = await resolveReferences(settings.provider ?? {}, options, {
    roots: ownRoots,
    env: ownEnv,
  })
  if (!object(providers)) throw new Error('OpenCode 原生提供商配置无效')
  const auth = { ...globalAuth, ...localAuth }
  for (const [id, provider] of Object.entries(providers)) {
    if (!object(provider)) throw new Error('OpenCode 原生提供商配置无效')
    const key = provider.options?.apiKey
    if (typeof key === 'string' && key.trim()) {
      if (key.trimStart().startsWith('!')) throw new Error('OpenCode 不执行凭据命令')
      // Keep the explicit API source identical in metadata and the private runtime auth store.
      auth[id] = { type: 'api', key }
    }
  }
  const disabled = settings.disabled_providers ?? [],
    enabled = settings.enabled_providers
  if (
    !Array.isArray(disabled) ||
    !disabled.every(text) ||
    (enabled !== undefined && (!Array.isArray(enabled) || !enabled.every(text)))
  )
    throw new Error('OpenCode 原生提供商开关配置无效')
  const cache =
    options.modelsPath ??
    (options.nativeHome
      ? join(home, '.cache/opencode/models.json')
      : process.env.OPENCODE_MODELS_PATH || join(home, '.cache/opencode/models.json'))
  return {
    sourceIds: [...sourceIds].sort(),
    auth,
    providers,
    disabled,
    enabled,
    modelsPath: cache,
    // The installed public multi-provider cache is 4.4 MB; scoped CLI output
    // remains capped at 4 MB. This larger cap does not apply to credential files.
    catalog: (await readDocument(cache, true, options, false, 8 * 1024 * 1024)) ?? {},
  }
}
/** Rebuild a private copy from current own sources; never restore an old worker account. */
export async function snapshotOpenCodeAuth(
  authDirectory: string,
  auth: Record<string, any>,
  providers: string[],
  signal?: AbortSignal,
): Promise<string> {
  const chosen = Object.fromEntries(
    providers.filter((id) => activeOpenCodeCredential(auth[id])).map((id) => [id, auth[id]]),
  )
  const digest = createHash('sha256').update(JSON.stringify(chosen)).digest('hex')
  const root = join(authDirectory, 'cliworker-snapshots', 'own-v2-' + digest)
  for (const path of [
    authDirectory,
    join(authDirectory, 'cliworker-snapshots'),
    root,
    join(root, 'opencode'),
  ]) {
    signal?.throwIfAborted()
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error('OpenCode 私有账号快照目录不安全')
  }
  const path = join(root, 'opencode/auth.json')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077)
      throw new Error('OpenCode 私有账号快照文件不安全')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(root, 'opencode', `.auth-${randomUUID()}.tmp`)
  try {
    signal?.throwIfAborted()
    await writeFile(temporary, JSON.stringify(chosen), { mode: 0o600, flag: 'wx' })
    signal?.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  signal?.throwIfAborted()
  return root
}
export async function inspectOpenCodeProfile(
  authDirectory: string,
  options: OpenCodeNativeOptions = {},
): Promise<AccountIdentity> {
  try {
    const profile = await readOpenCodeProfile(authDirectory, options)
    const types = new Set(
      Object.values(profile.auth)
        .filter(activeOpenCodeCredential)
        .map((auth) => auth.type),
    )
    if (types.size)
      return {
        state: 'configured',
        verification: 'local',
        ...(types.size === 1 ? { authMethod: types.has('api') ? ('api' as const) : ('oauth' as const) } : {}),
        summary: '已配置 OpenCode 账号',
      }
    if (
      Object.values(profile.auth).some(
        (auth) =>
          object(auth) &&
          auth.type === 'oauth' &&
          text(auth.access) &&
          typeof auth.expires === 'number' &&
          auth.expires <= Date.now(),
      )
    )
      return {
        state: 'unauthenticated',
        verification: 'local',
        summary: '登录已过期，请重新登录',
      }
    return Object.keys(profile.auth).length
      ? { state: 'unknown', verification: 'local', summary: '账号配置格式未知' }
      : { state: 'unconfigured', verification: 'local', summary: '尚未配置 OpenCode 账号' }
  } catch {
    options.signal?.throwIfAborted()
    return {
      state: 'unavailable',
      verification: 'local',
      summary: '账号配置读取失败，请检查配置',
    }
  }
}
