import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { CLI_LABELS, type CliId } from '../shared/types.ts'
import { captureCatalogMetadata, resolveCliExecutable } from './adapters.ts'
import { readCodexAccount } from './codex-account.ts'
import { readFirstPartyModelSources } from './first-party-models.ts'
import { readPiOmpAccountMaterial, safePiOmpAncestors } from './pi-omp-native.ts'
import { readOpenCodeProfile } from './opencode-native.ts'
import { openCodeAuthDirectory } from './opencode-adapter.ts'
import { assertHermesOwnAccounts } from './hermes-models.ts'
import { hermesHomeDirectory } from './hermes-adapter.ts'
import { readZCodeBindingMaterial, zcodeAuthDirectory } from './zcode-adapter.ts'
import { ProcessCleanupUnconfirmedError, type ProcessBackend, type RuntimeConfig } from './process.ts'

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const literal = (v: unknown): v is string =>
  text(v) && !/^(?:!|\$|op:\/\/|<|your[_ -]|placeholder|changeme)/i.test(v.trim()) && !/[\x00-\x1f]/.test(v)
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
const stable = (v: unknown): string => JSON.stringify(sort(v))
function sort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort)
  return object(v)
    ? Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => [key, sort(v[key])]),
      )
    : v
}

/** Safe public error; neither secrets nor native paths are interpolated. */
export class CliAccountBindingError extends Error {
  readonly code = 'CLI_OWN_ACCOUNT_REQUIRED'
  constructor(cli: CliId) {
    super(`${CLI_LABELS[cli]} 无法确认当前自身账号，请检查该 CLI 的登录或 API 配置`)
    this.name = 'CliAccountBindingError'
  }
}

interface BindingEntry {
  provider: string
  principal: unknown
  route?: unknown
}
interface BindingMaterial {
  sourceIds: string[]
  entries: BindingEntry[]
}

/** Unsigned claims are identity labels only; they never establish entitlement. */
function claims(value: unknown): Record<string, any> {
  if (!text(value) || value.length > 64 * 1024) return {}
  const parts = value.split('.')
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return {}
  const bytes = Buffer.from(parts[1]!, 'base64url')
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    return object(parsed) ? parsed : {}
  } catch {
    return {}
  } finally {
    bytes.fill(0)
  }
}
function expiry(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : undefined
}
function oauthPrincipal(value: Record<string, any>): unknown {
  const access = value.access ?? value.access_token ?? value.accessToken ?? value.key
  const refresh = value.refresh ?? value.refresh_token ?? value.refreshToken
  const identity = claims(value.id_token ?? value.idToken)
  const token = claims(access)
  const expires =
    expiry(value.expires ?? value.expires_at ?? value.expiresAt ?? value.expiry) ?? expiry(token.exp)
  if (!literal(refresh) && (!literal(access) || expires === undefined || expires <= Date.now())) return
  const accountId =
    value.accountId ?? value.account_id ?? token['https://api.openai.com/auth']?.chatgpt_account_id
  const subject = identity.sub ?? token.sub ?? value.userId ?? value.user_id
  const email = identity.email ?? value.email
  // Access/refresh token text is deliberately excluded: native OAuth may rotate both.
  if (!text(accountId) && !text(subject) && !text(email)) return
  return {
    kind: 'oauth',
    ...(text(accountId) ? { accountId } : {}),
    ...(text(subject) ? { subject } : text(email) ? { email: email.toLowerCase() } : {}),
    ...(text(identity.iss ?? token.iss) ? { issuer: identity.iss ?? token.iss } : {}),
    ...(text(value.organizationId ?? value.organization_id)
      ? { organization: value.organizationId ?? value.organization_id }
      : {}),
  }
}
function credentialEntry(provider: string, credential: any, route?: unknown): BindingEntry | undefined {
  if (!object(credential)) return
  if (['api', 'api_key'].includes(credential.type)) {
    const key = credential.key ?? credential.apiKey
    return literal(key) ? { provider, route, principal: { kind: 'api', key: hash(key) } } : undefined
  }
  if (credential.type === 'oauth') {
    const principal = oauthPrincipal(credential)
    if (principal) return { provider, route, principal }
  }
}

/** Bounded, no-follow local reads; missing files are never replaced by ambient credentials. */
async function read(path: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let bytes: Buffer | undefined
  try {
    await safePiOmpAncestors(dirname(path))
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024)
      throw new Error('Unsafe account metadata')
    bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('Account metadata changed')
    return bytes.subarray(0, offset).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  } finally {
    bytes?.fill(0)
    await handle?.close()
  }
}
async function document(path: string, signal: AbortSignal) {
  const raw = await read(path, signal)
  if (raw === undefined) return {}
  const value: unknown = JSON.parse(raw)
  if (!object(value)) throw new Error('Invalid native account')
  return value
}

function codexConfigPaths(root: string, project: string) {
  const ancestors: string[] = []
  for (let directory = resolve(project); ; ) {
    ancestors.unshift(join(directory, '.codex/config.toml'))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return [...new Set([join(root, 'config.toml'), ...ancestors])]
}
async function codexStore(project: string, signal: AbortSignal) {
  const root = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))
  let store = 'file'
  for (const path of codexConfigPaths(root, project)) {
    const raw = await read(path, signal)
    if (!raw) continue
    for (const line of raw.split(/\r?\n/)) {
      if (!/^\s*cli_auth_credentials_store\s*=/.test(line)) continue
      const match = /^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto)["']\s*(?:#.*)?$/.exec(line)
      if (!match) throw new CliAccountBindingError('codex')
      store = match[1]!
    }
  }
  return { root, store }
}
async function requireDefaultCodexRoute(root: string, project: string, signal: AbortSignal) {
  // These native overrides can route model/list and execution to another account.
  // Do not infer their endpoint/provider semantics from an unrelated auth.json.
  if (
    [
      'CODEX_API_KEY',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'CODEX_BASE_URL',
      'CHATGPT_BASE_URL',
      'CODEX_PROFILE',
    ].some((name) => text(process.env[name]))
  )
    throw new CliAccountBindingError('codex')
  for (const path of codexConfigPaths(root, project)) {
    const raw = await read(path, signal)
    if (!raw) continue
    if (
      raw
        .split(/\r?\n/)
        .some((line) =>
          /^\s*(?:["']?(?:model_provider|model_providers|openai_base_url|chatgpt_base_url|profile)["']?\s*=|\[\[?\s*(?:profiles|model_providers)(?:\.|\]|\s))/.test(
            line,
          ),
        )
    )
      throw new CliAccountBindingError('codex')
  }
}
/** File-backed Codex auth only. Native keyring/auto cannot use a stale auth.json for model queries. */
export async function readCodexOwnAccountSource(project: string, signal: AbortSignal) {
  const { root, store } = await codexStore(project, signal)
  if (store !== 'file') throw new CliAccountBindingError('codex')
  await requireDefaultCodexRoute(root, project, signal)
  const auth = await document(join(root, 'auth.json'), signal)
  if (literal(auth.OPENAI_API_KEY) && auth.auth_mode !== 'chatgpt')
    return {
      provider: 'openai',
      credential: { type: 'api' as const, key: auth.OPENAI_API_KEY },
      sourceIds: [root],
      baseUrl: 'https://api.openai.com/v1',
      nativeRouteConfirmed: true as const,
    }
  if (object(auth.tokens) && (!auth.auth_mode || auth.auth_mode === 'chatgpt')) {
    const credential = {
      type: 'oauth' as const,
      ...auth.tokens,
      access: auth.tokens.access_token,
      refresh: auth.tokens.refresh_token,
      accountId: auth.tokens.account_id,
      expires:
        expiry(auth.tokens.expires ?? auth.tokens.expires_at) ?? expiry(claims(auth.tokens.access_token).exp),
    }
    if (oauthPrincipal(credential))
      return {
        provider: 'openai-codex',
        credential,
        sourceIds: [root],
        baseUrl: 'https://chatgpt.com/backend-api',
        nativeRouteConfirmed: true as const,
      }
  }
  throw new CliAccountBindingError('codex')
}

const knownPiEnv: Record<string, string> = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  GEMINI_API_KEY: 'google',
  XAI_API_KEY: 'xai',
  GROQ_API_KEY: 'groq',
  OPENROUTER_API_KEY: 'openrouter',
  MISTRAL_API_KEY: 'mistral',
  CEREBRAS_API_KEY: 'cerebras',
  ZAI_API_KEY: 'zai',
  ZHIPU_API_KEY: 'zhipu-coding-plan',
  ZAI_CODING_CN_API_KEY: 'zai-coding-cn',
}
function ownKey(value: unknown, env: Record<string, string>): string | undefined {
  if (!literal(value)) return
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? (literal(env[value]) ? env[value] : undefined) : value
}

async function material(
  cli: CliId,
  backend: ProcessBackend,
  config: RuntimeConfig,
  project: string,
  signal: AbortSignal,
): Promise<BindingMaterial> {
  const home = homedir()
  if (cli === 'antigravity') {
    const root = join(home, '.gemini')
    const auth = await document(join(root, 'jetski-standalone-oauth-token'), signal)
    const principal =
      auth.auth_method === 'consumer' && object(auth.token)
        ? oauthPrincipal({ ...auth.token, id_token: auth.id_token })
        : undefined
    return { sourceIds: [root], entries: principal ? [{ provider: 'antigravity', principal }] : [] }
  }
  if (cli === 'codex') {
    const { root, store } = await codexStore(project, signal)
    if (store !== 'file') {
      await requireDefaultCodexRoute(root, project, signal)
      const executable = await resolveCliExecutable(cli, backend, config, signal)
      const identity = await readCodexAccount(backend, config, executable, project, signal)
      if (
        identity?.state !== 'authenticated' ||
        identity.authMethod !== 'oauth' ||
        !text(identity.accountLabel)
      )
        throw new CliAccountBindingError(cli)
      return {
        sourceIds: [root, `native-store:${store}`],
        entries: [
          {
            provider: 'openai-codex',
            principal: { kind: 'oauth', email: identity.accountLabel.toLowerCase() },
          },
        ],
      }
    }
    const source = await readCodexOwnAccountSource(project, signal)
    const entry = credentialEntry(source.provider, source.credential)
    return { sourceIds: source.sourceIds, entries: entry ? [entry] : [] }
  }
  if (cli === 'claude' || cli === 'kimi' || cli === 'mimo') {
    const executable = await resolveCliExecutable(cli, backend, config, signal)
    if (cli === 'claude') {
      const status = JSON.parse(
        await captureCatalogMetadata(
          backend,
          config,
          [executable, 'auth', 'status', '--json'],
          project,
          signal,
        ),
      )
      if (status.loggedIn === true && status.authMethod === 'claude.ai' && text(status.email))
        return {
          sourceIds: [
            resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')),
            'native:claude-auth-status',
          ],
          entries: [
            {
              provider: 'anthropic',
              principal: {
                kind: 'oauth',
                email: status.email.toLowerCase(),
                ...(text(status.orgId) ? { organization: status.orgId } : {}),
              },
            },
          ],
        }
    }
    const sources = await readFirstPartyModelSources(
      cli,
      executable,
      project,
      (argv, env) => captureCatalogMetadata(backend, config, argv, project, signal, env),
      signal,
    )
    return {
      sourceIds: sources.flatMap((source) => source.sourceIds),
      entries: sources.flatMap((source) => {
        const entry = credentialEntry(source.provider, source.credential, {
          baseUrl: source.baseUrl,
          apiType: source.apiType,
        })
        return entry ? [entry] : []
      }),
    }
  }
  if (cli === 'pi' || cli === 'omp') {
    const source = await readPiOmpAccountMaterial(cli, { accountRoot: config.stateDirectory, signal })
    if (source.configAuth.auth?.broker) throw new CliAccountBindingError(cli)
    const entries: BindingEntry[] = []
    for (const [provider, auth] of Object.entries(source.auth)) {
      if (!object(auth)) throw new CliAccountBindingError(cli)
      const resolved = ['api', 'api_key'].includes(auth.type)
        ? { ...auth, key: ownKey(auth.key ?? auth.apiKey, source.env), apiKey: undefined }
        : auth
      const entry = credentialEntry(provider, resolved)
      if (entry) entries.push(entry)
      else if (auth.type === 'oauth') throw new CliAccountBindingError(cli)
    }
    for (const row of source.credentials) {
      if (row.disabled_cause) continue
      const value = JSON.parse(row.data)
      const entry = credentialEntry(row.provider, {
        ...value,
        type: row.credential_type,
        ...(['api', 'api_key'].includes(row.credential_type)
          ? { key: ownKey(value.key ?? value.apiKey, source.env), apiKey: undefined }
          : {}),
      })
      if (entry) entries.push(entry)
      else if (row.credential_type === 'oauth') throw new CliAccountBindingError(cli)
    }
    for (const [provider, cfg] of Object.entries(source.models.providers ?? {}) as [string, any][]) {
      const key = ownKey(cfg.apiKey, source.env)
      if (key)
        entries.push(credentialEntry(provider, { type: 'api', key }, { baseUrl: cfg.baseUrl, api: cfg.api })!)
    }
    for (const [name, provider] of Object.entries(knownPiEnv))
      if (literal(source.env[name]))
        entries.push(credentialEntry(provider, { type: 'api', key: source.env[name] }, { env: name })!)
    return { sourceIds: source.sourceIds, entries }
  }
  if (cli === 'opencode') {
    const profile = await readOpenCodeProfile(openCodeAuthDirectory(config.stateDirectory), { signal })
    const entries: BindingEntry[] = []
    for (const [provider, credential] of Object.entries(profile.auth)) {
      if (profile.disabled.includes(provider) || (profile.enabled && !profile.enabled.includes(provider)))
        continue
      const entry = credentialEntry(provider, credential, {
        baseURL: profile.providers[provider]?.options?.baseURL,
        npm: profile.providers[provider]?.npm,
      })
      if (entry) entries.push(entry)
      else if (credential.type === 'oauth') throw new CliAccountBindingError(cli)
    }
    return { sourceIds: profile.sourceIds, entries }
  }
  if (cli === 'zcode') {
    const executable = await resolveCliExecutable(cli, backend, config, signal)
    const source = await readZCodeBindingMaterial(
      executable,
      zcodeAuthDirectory(config.zcodeAuthDirectory, config.stateDirectory),
      config.zcodeBuiltinConfig,
      { signal },
    )
    return {
      sourceIds: source.sourceIds,
      entries: source.credentials.map((entry) => ({
        provider: entry.provider,
        route: { baseUrl: entry.baseUrl, apiType: entry.apiType },
        principal:
          text(entry.identity) && !/^key-[a-f0-9]{24}$/.test(entry.identity)
            ? { kind: 'oauth', identity: entry.identity }
            : { kind: 'api', key: hash(entry.key) },
      })),
    }
  }
  if (cli === 'grok') {
    const root = join(home, '.grok'),
      auth = await document(join(root, 'auth.json'), signal)
    return {
      sourceIds: [root],
      entries: Object.entries(auth).flatMap(([provider, value]) => {
        if (!object(value) || value.auth_mode !== 'oidc') return []
        const principal = oauthPrincipal(value)
        return principal ? [{ provider, principal }] : []
      }),
    }
  }
  if (cli === 'hermes') {
    const root = hermesHomeDirectory(config.hermesHome)
    const source = await assertHermesOwnAccounts(root, signal)
    const provider = source.config.model?.provider
    const entries: BindingEntry[] = []
    if (provider === 'openai-codex') {
      const state = source.auth.providers?.[provider]
      const entry =
        state?.auth_mode === 'chatgpt'
          ? credentialEntry(provider, { ...state.tokens, type: 'oauth' })
          : undefined
      if (entry) entries.push(entry)
    } else if (provider === 'openrouter') {
      for (const [name, key] of Object.entries(source.env))
        if (/^OPENROUTER_API_KEY(?:_\d+)?$/.test(name) && literal(key))
          entries.push(credentialEntry(provider, { type: 'api', key })!)
      for (const row of source.auth.credential_pool?.[provider] ?? []) {
        if (row.disabled || row.status === 'exhausted') throw new CliAccountBindingError(cli)
        const key = row.source?.startsWith('env:')
          ? source.env[row.source.slice(4)]
          : row.runtime_api_key || row.access_token
        const entry = credentialEntry(provider, { type: 'api', key }, { baseUrl: row.base_url })
        if (!entry) throw new CliAccountBindingError(cli)
        entries.push(entry)
      }
    }
    return {
      sourceIds: source.sourceIds,
      entries: entries.map((entry) => ({
        ...entry,
        route: { ...(object(entry.route) && entry.route), baseUrl: source.config.model?.base_url },
      })),
    }
  }
  return { sourceIds: [], entries: [] }
}

/** Host-only account epoch. Never return it from a Gateway response or write credentials to storage. */
export async function readCliAccountBinding(
  cli: CliId,
  backend: ProcessBackend,
  config: RuntimeConfig,
  project: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted()
  try {
    const value = await material(cli, backend, config, project, signal)
    signal.throwIfAborted()
    if (!value.entries.length || !value.sourceIds.length) throw new CliAccountBindingError(cli)
    const sources = [
      ...new Set(value.sourceIds.map((path) => (isAbsolute(path) ? resolve(path) : path))),
    ].sort()
    const entries = [...new Set(value.entries.map(stable))].sort()
    return `cli-account-v1:${hash(stable({ cli, sources, entries }))}`
  } catch (error) {
    if (error instanceof ProcessCleanupUnconfirmedError) throw error
    signal.throwIfAborted()
    if (error instanceof CliAccountBindingError) throw error
    throw new CliAccountBindingError(cli)
  }
}
