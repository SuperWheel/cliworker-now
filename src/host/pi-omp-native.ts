import { constants } from 'node:fs'
import { lstat, open, mkdir, writeFile, rename, rm, mkdtemp, realpath, readlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml } from 'yaml'
import type { AccountIdentity } from './account-identity.ts'
import { authenticatedAccountLogins, providerLogin, usableNativeApiKey } from './account-login.ts'
import type { AccountLogin, AccountSource } from '../shared/accounts.ts'
import type { PiOmpCli } from './pi-omp-adapter.ts'
import { acquireOwnAccountLease, releaseOwnAccountLease, OWN_ACCOUNT_BUSY } from './own-account-lease.mjs'
import {
  refreshFingerprint,
  refreshPrincipal,
  refreshJson,
  writeRefreshJson,
  assertPiOmpRefreshCache,
  assertPiOmpRefreshSources,
} from './pi-omp-refresh.mjs'

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const defaultRoot = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now')
const runtimeEnv =
  /^(?:PATH|HOME|SHELL|TMPDIR|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|OMP_AUTH_BROKER_.*|OMP_PROFILE|PI_PROFILE|PI_CONFIG_DIR|PI_CODING_AGENT_DIR|LD_.*|DYLD_.*)$/
const knownProviderEnvironment: Record<string, string> = {
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
function configuredEnvironmentRefs(value: unknown, output = new Set<string>()) {
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)) output.add(value)
  if (object(value) || Array.isArray(value))
    for (const entry of Object.values(value)) configuredEnvironmentRefs(entry, output)
  return output
}
export interface PiOmpNativeOptions {
  accountRoot?: string
  nativeHome?: string
  signal?: AbortSignal
  /** Deprecated. Worker copies are never authoritative credential sources. */
  preserveCredentials?: boolean
  /** Internal runtime mode; direct metadata projections never write native accounts. */
  sharedOAuth?: boolean
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
  sourceId: string
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
    sourceId: resolve(path),
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
      ...(object(config.auth)
        ? { auth: Object.fromEntries(Object.entries(config.auth).filter(([key]) => key !== 'broker')) }
        : {}),
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
            .prepare(
              'SELECT rowid AS native_rowid,provider,credential_type,data,disabled_cause FROM auth_credentials',
            )
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
  // Earlier versions wrote this exact Host-only route into the plugin store.
  // Preserve native/user configuration, including an explicitly supplied own .env.
  const legacy = result.models.providers?.['cliworker-zai-cn']
  if (
    object(legacy) &&
    legacy.apiKey === 'ZAI_CODING_CN_API_KEY' &&
    legacy.baseUrl === 'https://open.bigmodel.cn/api/coding/paas/v4' &&
    !result.env.ZAI_CODING_CN_API_KEY
  )
    delete result.models.providers['cliworker-zai-cn']
  return result
}
async function withSources<T>(
  cli: PiOmpCli,
  options: PiOmpNativeOptions,
  fn: (sources: NativeSource[], scratch: string) => Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted()
  const root = options.accountRoot ?? defaultRoot()
  await safePiOmpAncestors(root)
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'cliworker-native-read-'))
  try {
    const global = join(options.nativeHome ?? homedir(), cli === 'pi' ? '.pi' : '.omp', 'agent')
    const paths = [...new Set([global, piOmpAccountDirectory(cli, root)])]
    const results: NativeSource[] = []
    for (const path of paths) {
      options.signal?.throwIfAborted()
      results.push(await source(cli, path, scratch))
    }
    options.signal?.throwIfAborted()
    return await fn(results, scratch)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Current native roots only. Account actions must never remove a merged worker copy. */
export async function readPiOmpLogoutSources(
  cli: PiOmpCli,
  stateDirectory: string | undefined,
  signal: AbortSignal,
  options: { nativeHome?: string } = {},
) {
  return withSources(cli, { accountRoot: stateDirectory, ...options, signal }, async (sources) =>
    sources.flatMap((source, index) => {
      const configured =
        Object.keys(source.auth).length ||
        source.credentials.length ||
        Object.values(source.models.providers ?? {}).some(
          (provider) => object(provider) && provider.apiKey,
        ) ||
        Object.values(knownProviderEnvironment).some((key) => usableNativeApiKey(source.env[key]))
      if (!configured) return []
      return [
        {
          id: (index === 0 ? 'native' : 'plugin') as AccountSource,
          label: index === 0 ? 'CLI 全局账号' : '插件账号',
          directory: source.sourceId,
          env: source.env,
          config: source.config ?? {},
          stored: Object.keys(source.auth).length > 0 || source.credentials.length > 0,
        },
      ]
    }),
  )
}

export async function listPiOmpAccountSources(
  cli: PiOmpCli,
  stateDirectory: string | undefined,
  signal: AbortSignal,
  options: { nativeHome?: string } = {},
) {
  return (await readPiOmpLogoutSources(cli, stateDirectory, signal, options)).map(({ id, label }) => ({
    id,
    label,
  }))
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
  if (Object.values(knownProviderEnvironment).some((key) => env[key])) kinds.add('api')
  return { auth, providers, env, credentialProviders, cache, kinds, expired }
}
/** Internal binding material only. Never expose these values through public status. */
export async function readPiOmpAccountMaterial(cli: PiOmpCli, options: PiOmpNativeOptions = {}) {
  return withSources(cli, options, async (sources) => {
    const merged = mergeSources(sources)
    return {
      auth: merged.auth,
      credentials: [...merged.credentialProviders.values()].flat(),
      env: merged.env,
      models: { providers: merged.providers },
      configAuth: Object.assign({}, ...sources.map((s) => s.config ?? {})),
      sourceIds: sources
        .filter(
          (s) =>
            Object.keys(s.auth).length ||
            s.credentials.length ||
            Object.keys(s.env).length ||
            Object.keys(s.config?.auth ?? {}).length ||
            Object.values(s.models.providers ?? {}).some((p) => object(p) && p.apiKey),
        )
        .map((s) => s.sourceId),
    }
  })
}
async function sharedOAuthStore(cli: PiOmpCli, sources: NativeSource[], options: PiOmpNativeOptions) {
  if (!options.sharedOAuth) return undefined
  const merged = mergeSources(sources)
  const owners = new Map<string, NativeSource>()
  for (const source of sources)
    for (const provider of cli === 'pi'
      ? Object.keys(source.auth)
      : new Set(source.credentials.map((row) => row.provider)))
      owners.set(provider, source)
  const credentials =
    cli === 'pi'
      ? Object.entries(merged.auth).map(([provider, data]) => ({
          provider,
          data,
          row: undefined as any,
          cacheRowId: undefined as number | undefined,
        }))
      : [...merged.credentialProviders.values()].flat().map((row, index) => ({
          provider: row.provider,
          data: { ...JSON.parse(row.data), type: row.credential_type },
          row,
          cacheRowId: index + 1,
        }))
  const entries: any[] = []
  const fixed: any[] = []
  for (const { provider, data, row, cacheRowId } of credentials) {
    if (data.type !== 'oauth' || row?.disabled_cause) {
      fixed.push({
        provider,
        ...(row ? { cacheRowId } : {}),
        hash: refreshFingerprint(row ? { ...data, disabled_cause: row.disabled_cause } : data),
      })
      continue
    }
    const principal = refreshPrincipal(data)
    if (!principal) throw new Error('无法确认 OAuth 续期账号，请使用该 CLI 自身 API 配置')
    const owner = owners.get(provider)!
    const path = join(await realpath(owner.sourceId), cli === 'pi' ? 'auth.json' : 'agent.db')
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe OAuth source')
    entries.push({
      provider,
      path,
      hash: refreshFingerprint(data),
      principal,
      dev: info.dev,
      ino: info.ino,
      ...(row ? { rowId: row.native_rowid, cacheRowId } : {}),
    })
  }
  if (!entries.length) return undefined
  // One physical store and lease per CLI/source set, independent of worker/project.
  const parent = join(options.accountRoot ?? defaultRoot(), 'account-runtime', cli, 'oauth')
  await safePiOmpAncestors(parent)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  // Provider order/additions must never create another lock for the same source.
  const sourceKey = refreshFingerprint({
    cli,
    home: await realpath(options.nativeHome ?? homedir()),
    accountRoot: await realpath(options.accountRoot ?? defaultRoot()),
  })
  const root = join(await realpath(parent), sourceKey)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error('Unsafe OAuth runtime')
  const agent = join(root, 'agent')
  const receipt = {
    version: 1,
    cli,
    revision: refreshFingerprint({
      entries,
      auth: merged.auth,
      credentials: [...merged.credentialProviders.values()],
      env: merged.env,
      providers: merged.providers,
      config: sources.map((source) => source.config),
    }),
    entries,
    fixed,
  }
  const nonce = randomUUID()
  await acquireOwnAccountLease(root, nonce)
  try {
    options.signal?.throwIfAborted()
    await mkdir(agent, { recursive: true, mode: 0o700 })
    const agentInfo = await lstat(agent)
    if (!agentInfo.isDirectory() || agentInfo.isSymbolicLink() || agentInfo.mode & 0o077)
      throw new Error('Unsafe OAuth runtime')
    let previous
    try {
      previous = await refreshJson(join(root, 'receipt.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (previous && refreshFingerprint(previous) === refreshFingerprint(receipt)) {
      await assertPiOmpRefreshSources(root, receipt)
      await assertPiOmpRefreshCache(root, receipt)
      return { root, agent, receipt, nonce, reuse: true }
    }
    // A failed rebuild must not leave an old valid receipt over partially new data.
    await rm(join(root, 'receipt.json'), { force: true })
    return { root, agent, receipt, nonce, reuse: false }
  } catch (error) {
    await releaseOwnAccountLease(root, nonce)
    throw error
  }
}
/** Global native input then plugin account overrides by provider; empty plugin auth never hides global accounts. */
export async function snapshotPiOmpNative(
  cli: PiOmpCli,
  destination: string,
  options: PiOmpNativeOptions = {},
) {
  try {
    return await withSources(cli, options, async (sources) => {
      let unsupportedOAuth = false
      if (options.sharedOAuth) {
        // Resolve the native override first. An unsupported current OAuth account
        // must still shadow lower-priority credentials for the same provider.
        const authOwners = new Map<string, NativeSource>()
        const credentialOwners = new Map<string, NativeSource>()
        for (const source of sources) {
          for (const provider of Object.keys(source.auth)) authOwners.set(provider, source)
          for (const row of source.credentials) credentialOwners.set(row.provider, source)
        }
        sources = sources.map((source) => ({
          ...source,
          auth: Object.fromEntries(
            Object.entries(source.auth).filter(([provider, value]) => {
              if (authOwners.get(provider) !== source) return false
              const allowed = value.type !== 'oauth' || !!refreshPrincipal(value)
              if (!allowed) unsupportedOAuth = true
              return allowed
            }),
          ),
          credentials: source.credentials.filter((row) => {
            if (credentialOwners.get(row.provider) !== source) return false
            const allowed =
              row.credential_type !== 'oauth' ||
              !!row.disabled_cause ||
              !!refreshPrincipal({ ...JSON.parse(row.data), type: 'oauth' })
            if (!allowed) unsupportedOAuth = true
            return allowed
          }),
        }))
      }
      const { auth, providers, kinds, env, credentialProviders, cache, expired } = mergeSources(sources)
      if (unsupportedOAuth && !kinds.size)
        throw new Error('无法确认 OAuth 续期账号，请使用该 CLI 自身 API 配置')
      const shared = await sharedOAuthStore(cli, sources, options)
      const target = shared?.agent ?? destination
      try {
        if (shared?.reuse)
          return {
            configured: kinds.size > 0,
            expired,
            providers: Object.keys(providers),
            env,
            directory: target,
            leaseDirectory: shared.root,
            receipt: shared.receipt,
          }
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
          options.signal?.throwIfAborted()
          const temporary = join(target, `.native-${randomUUID()}.tmp`)
          await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
          await rename(temporary, join(target, name))
        }
        if (cli === 'omp') {
          const nativeAuth = Object.assign({}, ...sources.map((s) => s.config ?? {}))
          const authConfig = join(target, 'native-auth.json')
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
            const temporary = join(target, `.native-${randomUUID()}.db`)
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
            await rename(temporary, join(target, name))
            // Old auxiliary files must not apply a previous DB's WAL to the replacement.
            await Promise.all(
              ['-wal', '-shm'].map((suffix) => rm(join(target, name + suffix), { force: true })),
            )
          }
        }
        if (shared) {
          options.signal?.throwIfAborted()
          await assertPiOmpRefreshSources(shared.root, shared.receipt)
          await writeRefreshJson(join(shared.root, 'receipt.json'), shared.receipt)
        }
        return {
          configured: kinds.size > 0,
          expired,
          providers: Object.keys(providers),
          env,
          directory: target,
          ...(shared ? { leaseDirectory: shared.root, receipt: shared.receipt } : {}),
        }
      } finally {
        if (shared) await releaseOwnAccountLease(shared.root, shared.nonce)
      }
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    if (
      error instanceof Error &&
      [
        OWN_ACCOUNT_BUSY,
        '无法确认 OAuth 续期账号，请使用该 CLI 自身 API 配置',
        '账号配置已变化，请重新刷新模型',
      ].includes(error.message)
    )
      throw error
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
      const { auth, providers, env, credentialProviders, expired } = mergeSources(sources)
      const logins: AccountLogin[] = []
      const ownValue = (value: unknown, referenceOnly = false) =>
        typeof value === 'string' &&
        (referenceOnly
          ? /^[A-Z][A-Z0-9_]*$/.test(value)
          : Object.values(knownProviderEnvironment).includes(value))
          ? env[value]
          : value
      const add = (provider: string, method: 'api' | 'oauth') => {
        const config = providers[provider]
        logins.push(
          providerLogin(provider, method, {
            baseUrl: ownValue(config?.baseUrl, true),
            name: config?.name,
          }),
        )
      }
      let invalidOAuth = false
      const inspect = (provider: string, type: string, value: Record<string, any>, disabled?: unknown) => {
        if (credentialState(type, value, disabled) !== 'configured') return
        if (type === 'api' || type === 'api_key') {
          if (usableNativeApiKey(ownValue(value.key ?? value.apiKey))) add(provider, 'api')
        } else if (
          usableNativeApiKey(value.access) &&
          (value.expires >= Date.now() || usableNativeApiKey(value.refresh))
        )
          add(provider, 'oauth')
        else invalidOAuth = true
      }
      for (const [provider, value] of Object.entries(auth) as [string, Record<string, any>][])
        inspect(provider, value.type, value)
      for (const [provider, rows] of credentialProviders)
        for (const row of rows)
          inspect(provider, row.credential_type, JSON.parse(row.data), row.disabled_cause)
      for (const [provider, value] of Object.entries(providers) as [string, Record<string, any>][]) {
        if (usableNativeApiKey(ownValue(value.apiKey, true))) add(provider, 'api')
      }
      for (const [provider, variable] of Object.entries(knownProviderEnvironment))
        if (usableNativeApiKey(env[variable])) add(provider, 'api')
      if (logins.length) return authenticatedAccountLogins(logins)
      if (expired || invalidOAuth)
        return { state: 'unauthenticated', verification: 'local', summary: '原生登录已失效，请重新登录' }
      if (Object.keys(auth).length || credentialProviders.size || Object.keys(providers).length)
        return { state: 'configured', verification: 'local', summary: '尚未配置有效凭据' }
      return { state: 'unconfigured', verification: 'local', summary: '尚未配置原生账号' }
    })
  } catch {
    signal.throwIfAborted()
    return { state: 'unavailable', summary: '账号或模型配置读取失败，请检查配置' }
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
