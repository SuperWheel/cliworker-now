import { constants } from 'node:fs'
import { lstat, open, mkdir, writeFile, rename, rm, mkdtemp, realpath, readlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml } from 'yaml'
import type { AccountIdentity } from './account-identity.ts'
import type { PiOmpCli } from './pi-omp-adapter.ts'

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const defaultRoot = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now')
const runtimeEnv =
  /^(?:PATH|HOME|SHELL|TMPDIR|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|OMP_PROFILE|PI_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|LD_.*|DYLD_.*)$/
function configuredEnvironmentRefs(value: unknown, output = new Set<string>()) {
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)) output.add(value)
  if (object(value) || Array.isArray(value))
    for (const entry of Object.values(value)) configuredEnvironmentRefs(entry, output)
  return output
}
export interface PiOmpNativeOptions {
  accountRoot?: string
  nativeHome?: string
  preserveCredentials?: boolean
}
export const piOmpAccountDirectory = (cli: PiOmpCli, root = defaultRoot()) =>
  join(root, 'accounts', cli, 'agent')

export async function safePiOmpAncestors(path: string) {
  let current: string = sep
  for (const component of resolve(path).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        // macOS system aliases are immutable trust roots, unlike user links.
        if (
          !(
            (current === '/var' || current === '/tmp') &&
            resolve(dirname(current), await readlink(current)) === `/private${current}`
          )
        )
          throw new Error('Unsafe native account ancestor symlink')
      } else if (!info.isDirectory()) throw new Error('Unsafe native account directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
}
/** Bounded, no-follow reads. Never create, chmod, checkpoint, or migrate a source. */
async function readOptional(path: string, limit = 2 * 1024 * 1024): Promise<Buffer | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    const directory = dirname(path)
    await safePiOmpAncestors(directory)
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unsafe native account directory')
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > limit)
      throw new Error('Unsafe native account file')
    const buffer = Buffer.alloc(before.size + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const after = await file.stat()
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('Native account changed during read')
    return buffer.subarray(0, bytesRead)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  } finally {
    await file?.close()
  }
}
function parseObject(raw: Buffer | undefined, yaml = false): Record<string, any> {
  if (!raw) return {}
  const result: unknown = yaml
    ? parseYaml(raw.toString('utf8'), { maxAliasCount: 0 })
    : JSON.parse(raw.toString('utf8'))
  if (!object(result)) throw new Error('Invalid native account config')
  return result
}
function rejectCommands(value: unknown): void {
  if (typeof value === 'string' && value.trimStart().startsWith('!'))
    throw new Error('Native credential command helpers are not enabled in plugin workers')
  if (object(value) || Array.isArray(value)) for (const entry of Object.values(value)) rejectCommands(entry)
}
function credentialState(
  type: string,
  data: unknown,
  disabled?: unknown,
): 'configured' | 'expired' | undefined {
  if (!object(data)) throw new Error('Invalid native credential data')
  if (disabled) return 'expired'
  if (type === 'api' || type === 'api_key') {
    const key = data.key ?? data.apiKey
    if (typeof key !== 'string' || !key.trim()) throw new Error('Invalid native API credential')
    return 'configured'
  }
  if (type === 'oauth') {
    if (typeof data.access !== 'string' || !data.access) throw new Error('Invalid native OAuth credential')
    if (
      typeof data.expires !== 'number' ||
      !Number.isFinite(data.expires) ||
      (data.refresh !== undefined && typeof data.refresh !== 'string')
    )
      throw new Error('Invalid native OAuth expiry/refresh')
    if (data.expires < Date.now() && !data.refresh) return 'expired'
    return 'configured'
  }
  throw new Error('Unsupported native credential type')
}
interface NativeSource {
  auth: Record<string, any>
  models: Record<string, any>
  modelCache: any[]
  modelsStore: Record<string, any>
  credentials: any[]
  config?: Record<string, any>
  kinds: Set<string>
  expired: boolean
  env: Record<string, string>
}
async function source(cli: PiOmpCli, path: string, scratch?: string): Promise<NativeSource> {
  const result: NativeSource = {
    auth: {},
    models: {},
    modelCache: [],
    modelsStore: {},
    credentials: [],
    kinds: new Set(),
    expired: false,
    env: {},
  }
  const dotenv = await readOptional(join(path, '.env'), 64 * 1024)
  if (dotenv)
    for (const line of dotenv.toString('utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim())
      if (!match) throw new Error('Invalid native environment config')
      let value = match[2]
      if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'")))
        value = value.slice(1, -1)
      if (/`|\$\(|\x00/.test(value)) throw new Error('Native environment command interpolation is disabled')
      // Preserve provider credential env only, never PATH/HOME/runtime overrides.
      if (!runtimeEnv.test(match[1])) result.env[match[1]] = value
    }
  if (cli === 'pi') {
    result.auth = parseObject(await readOptional(join(path, 'auth.json')))
    result.models = parseObject(await readOptional(join(path, 'models.json')))
    result.modelsStore = parseObject(await readOptional(join(path, 'models-store.json'), 16 * 1024 * 1024))
    if (Object.values(result.modelsStore).some((entry) => !object(entry) || !Array.isArray(entry.models)))
      throw new Error('Invalid Pi native model cache')
    const settings = parseObject(await readOptional(join(path, 'settings.json')))
    result.config =
      settings.defaultThinkingLevel === undefined
        ? {}
        : { defaultThinkingLevel: settings.defaultThinkingLevel }
    rejectCommands(result.auth)
    rejectCommands(result.models)
    for (const auth of Object.values(result.auth)) {
      if (!object(auth) || typeof auth.type !== 'string') throw new Error('Invalid Pi native credential')
      const state = credentialState(auth.type, auth)
      if (state === 'configured') result.kinds.add(auth.type)
      if (state === 'expired') result.expired = true
    }
  } else {
    result.models = parseObject(await readOptional(join(path, 'models.yml')), true)
    const config = parseObject(await readOptional(join(path, 'config.yml')), true)
    // Only model/auth-specific settings enter workers; extension/hooks/tools do not.
    result.config = {
      ...(object(config.auth) ? { auth: config.auth } : {}),
      ...(config.defaultThinkingLevel === undefined
        ? {}
        : { defaultThinkingLevel: config.defaultThinkingLevel }),
    }
    rejectCommands(result.models)
    rejectCommands(result.config)
    for (const provider of Object.values(result.models.providers ?? {})) {
      if (!object(provider)) throw new Error('Invalid OMP native provider')
      // Literal custom-provider keys are local configuration evidence. Environment
      // names alone do not establish auth (Host's CN env is supplied separately).
      if (
        typeof provider.apiKey === 'string' &&
        !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKey) &&
        provider.apiKey.trim()
      )
        result.kinds.add('api')
    }
    for (const name of ['agent.db', 'models.db']) {
      const bytes = await readOptional(join(path, name), 16 * 1024 * 1024)
      if (!bytes) continue
      const wal = await readOptional(join(path, `${name}-wal`), 32 * 1024 * 1024)
      if (!scratch) throw new Error('Missing private SQLite scratch directory')
      const copy = join(scratch, `${randomUUID()}.db`)
      await writeFile(copy, bytes, { flag: 'wx', mode: 0o600 })
      if (wal) await writeFile(`${copy}-wal`, wal, { flag: 'wx', mode: 0o600 })
      let db: DatabaseSync | undefined
      try {
        db = new DatabaseSync(copy)
        if ((db.prepare('PRAGMA quick_check').get() as any)?.quick_check !== 'ok')
          throw new Error('Invalid native account database')
        const tables = new Set(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((x: any) => x.name),
        )
        if (name === 'agent.db' && tables.has('auth_credentials')) {
          result.credentials = db
            .prepare('SELECT provider,credential_type,data,disabled_cause FROM auth_credentials')
            .all()
          for (const row of result.credentials) {
            const data: unknown = JSON.parse(row.data)
            rejectCommands(data)
            const state = credentialState(row.credential_type, data, row.disabled_cause)
            if (state === 'configured') result.kinds.add(row.credential_type)
            if (state === 'expired') result.expired = true
          }
        }
        if (name === 'models.db' && tables.has('model_cache'))
          result.modelCache = db
            .prepare(
              'SELECT provider_id,version,updated_at,authoritative,static_fingerprint,models FROM model_cache',
            )
            .all()
        for (const row of result.modelCache) {
          if (!Array.isArray(JSON.parse(row.models))) throw new Error('Invalid OMP native model cache')
        }
      } finally {
        db?.close()
        await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(copy + suffix, { force: true })))
      }
    }
  }
  const refs = configuredEnvironmentRefs([result.models, result.config])
  for (const key of Object.keys(result.env))
    if (!/_(?:API_KEY|TOKEN|SECRET)$/.test(key) && !refs.has(key)) delete result.env[key]
  return result
}
async function withSources<T>(
  cli: PiOmpCli,
  options: PiOmpNativeOptions,
  fn: (sources: NativeSource[], scratch: string) => Promise<T>,
): Promise<T> {
  const root = options.accountRoot ?? defaultRoot()
  await safePiOmpAncestors(root)
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'cliworker-native-read-'))
  try {
    const global = join(options.nativeHome ?? homedir(), cli === 'pi' ? '.pi' : '.omp', 'agent')
    const paths = [...new Set([global, piOmpAccountDirectory(cli, root)])]
    const results: NativeSource[] = []
    for (const path of paths) results.push(await source(cli, path, scratch))
    return await fn(results, scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
function mergeSources(sources: NativeSource[]) {
  const auth = Object.assign(Object.create(null), ...sources.map((s) => s.auth))
  const providers = Object.assign(Object.create(null), ...sources.map((s) => s.models.providers ?? {}))
  const env = Object.assign(Object.create(null), ...sources.map((s) => s.env)) as Record<string, string>
  const credentialProviders = new Map<string, any[]>()
  const cache = new Map<string, any>()
  for (const s of sources) {
    for (const provider of new Set(s.credentials.map((row) => row.provider)))
      credentialProviders.set(
        provider,
        s.credentials.filter((row) => row.provider === provider),
      )
    for (const row of s.modelCache) cache.set(row.provider_id, row)
  }
  const kinds = new Set<string>()
  let expired = false
  for (const entry of Object.values(auth) as Record<string, any>[]) {
    const state = credentialState(entry.type, entry)
    if (state === 'configured') kinds.add(entry.type)
    if (state === 'expired') expired = true
  }
  for (const row of [...credentialProviders.values()].flat()) {
    const state = credentialState(row.credential_type, JSON.parse(row.data), row.disabled_cause)
    if (state === 'configured') kinds.add(row.credential_type)
    if (state === 'expired') expired = true
  }
  for (const provider of Object.values(providers) as Record<string, any>[]) {
    if (
      typeof provider.apiKey === 'string' &&
      provider.apiKey &&
      (!/^[A-Z][A-Z0-9_]*$/.test(provider.apiKey) || env[provider.apiKey])
    )
      kinds.add('api')
  }
  const knownEnv: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    xai: 'XAI_API_KEY',
    groq: 'GROQ_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    zai: 'ZAI_API_KEY',
    'zhipu-coding-plan': 'ZHIPU_API_KEY',
    'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
  }
  if (Object.values(knownEnv).some((key) => env[key])) kinds.add('api')
  return { auth, providers, env, credentialProviders, cache, kinds, expired }
}
/** Global native input then plugin account overrides by provider; empty plugin auth never hides global accounts. */
export async function snapshotPiOmpNative(
  cli: PiOmpCli,
  destination: string,
  options: PiOmpNativeOptions = {},
) {
  try {
    return await withSources(cli, options, async (sources, scratch) => {
      if (options.preserveCredentials) {
        const current = await source(cli, destination, scratch)
        current.models = {}
        current.modelCache = []
        current.modelsStore = {}
        current.env = {
          ...(await restorePiOmpEnvironment(destination)),
          ...Object.assign(Object.create(null), ...sources.map((source) => source.env)),
        }
        // Only this worker's refreshed credentials take precedence on continuation.
        sources.push(current)
      }
      const { auth, providers, kinds, env, credentialProviders, cache, expired } = mergeSources(sources)
      const files: Record<string, unknown> =
        cli === 'pi'
          ? {
              'auth.json': auth,
              'models.json': { providers },
              'settings.json': Object.assign(
                Object.create(null),
                ...sources.map((source) => source.config ?? {}),
              ),
              'native-env.json': env,
              'models-store.json': Object.assign(Object.create(null), ...sources.map((s) => s.modelsStore)),
            }
          : { 'models.yml': { providers }, 'native-env.json': env }
      for (const [name, value] of Object.entries(files)) {
        const temporary = join(destination, `.native-${randomUUID()}.tmp`)
        await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
        await rename(temporary, join(destination, name))
      }
      if (cli === 'omp') {
        const nativeAuth = Object.assign({}, ...sources.map((s) => s.config ?? {}))
        const authConfig = join(destination, 'native-auth.json')
        const authTemp = `${authConfig}.${randomUUID()}.tmp`
        await writeFile(authTemp, JSON.stringify(nativeAuth), { flag: 'wx', mode: 0o600 })
        await rename(authTemp, authConfig)
        // Fresh DBs hold only native credential/catalog rows. No history, memory,
        // user settings, jobs, leases or session paths are copied into a worker.
        for (const [name, schema, rows, insert] of [
          [
            'agent.db',
            'CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT, identity_key TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)',
            [...credentialProviders.values()].flat(),
            'INSERT INTO auth_credentials(provider,credential_type,data,disabled_cause) VALUES(?,?,?,?)',
          ],
          [
            'models.db',
            "CREATE TABLE model_cache(provider_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at INTEGER NOT NULL,authoritative INTEGER NOT NULL DEFAULT 0,static_fingerprint TEXT NOT NULL DEFAULT '',models TEXT NOT NULL)",
            [...cache.values()],
            'INSERT INTO model_cache VALUES(?,?,?,?,?,?)',
          ],
        ] as const) {
          const temporary = join(destination, `.native-${randomUUID()}.db`)
          await writeFile(temporary, '', { flag: 'wx', mode: 0o600 })
          const db = new DatabaseSync(temporary)
          try {
            db.exec(schema)
            for (const row of rows)
              db.prepare(insert).run(
                ...(name === 'agent.db'
                  ? [row.provider, row.credential_type, row.data, row.disabled_cause]
                  : [
                      row.provider_id,
                      row.version,
                      row.updated_at,
                      row.authoritative,
                      row.static_fingerprint,
                      row.models,
                    ]),
              )
          } finally {
            db.close()
          }
          await rename(temporary, join(destination, name))
          // Old auxiliary files must not apply a previous DB's WAL to the replacement.
          await Promise.all(
            ['-wal', '-shm'].map((suffix) => rm(join(destination, name + suffix), { force: true })),
          )
        }
      }
      return { configured: kinds.size > 0, expired, providers: Object.keys(providers), env }
    })
  } catch {
    throw new Error('无法安全读取 Pi/OMP 原生账号或模型配置，请在账号终端检查')
  }
}
export async function inspectPiOmpNativeAccount(
  cli: PiOmpCli,
  stateDirectory: string | undefined,
  signal: AbortSignal,
  options: { nativeHome?: string } = {},
): Promise<AccountIdentity> {
  signal.throwIfAborted()
  try {
    return await withSources(cli, { accountRoot: stateDirectory, ...options }, async (sources) => {
      signal.throwIfAborted()
      const { kinds, expired } = mergeSources(sources)
      if (kinds.size)
        return {
          state: 'configured',
          verification: 'local',
          ...(kinds.size === 1
            ? { authMethod: [...kinds][0] === 'oauth' ? ('oauth' as const) : ('api' as const) }
            : {}),
          summary: '已读取原生账号配置；插件账号优先于同提供商的全局账号，未进行远程验证',
        }
      if (expired)
        return { state: 'unauthenticated', verification: 'local', summary: '原生登录已失效，请重新登录' }
      return { state: 'unconfigured', verification: 'local', summary: '尚未配置 Pi/OMP 原生账号' }
    })
  } catch {
    signal.throwIfAborted()
    return { state: 'unavailable', summary: '无法安全读取原生账号或模型配置，请在账号终端检查' }
  }
}

export async function restorePiOmpEnvironment(directory: string): Promise<Record<string, string>> {
  try {
    const value = parseObject(await readOptional(join(directory, 'native-env.json'), 64 * 1024))
    if (
      Object.entries(value).some(
        ([key, item]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || runtimeEnv.test(key) || typeof item !== 'string',
      )
    )
      throw new Error('Invalid native environment snapshot')
    return value
  } catch {
    throw new Error('无法安全读取已有 Worker 的原生凭据环境')
  }
}
