import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { EFFORTS, type ModelChoice } from '../shared/types.ts'
import { probeAccountModels, type AccountModelInput } from './account-models.mjs'

type Capture = (argv: string[], env?: Record<string, string>) => Promise<string>
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const literal = (v: unknown): v is string =>
  typeof v === 'string' && !!v.trim() && !/[\s\x00-\x1f{}$]/.test(v) && !v.startsWith('!')
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v)
const authHeaders = (v: unknown) =>
  record(v) &&
  Object.keys(v).some((k) => /authorization|api[-_]?key|token|cookie|organization|project/i.test(k))

function parseMetadata(value: string): Record<string, any> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (record(parsed)) return parsed
  } catch {}
  throw new Error('CLI 配置格式无效，请检查配置')
}

/** Private material only. Never return this structure through Gateway or persist it. */
export interface FirstPartyModelSource extends AccountModelInput {
  sourceIds: string[]
  nativeFullModelIds?: boolean
  nativeModels: { remoteId: string; choice: ModelChoice }[]
}
export async function readFirstPartyJson(path: string): Promise<Record<string, any>> {
  let file, bytes: Buffer | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) throw new Error('账号配置文件不可用')
    bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat()
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('账号配置读取期间发生变化')
    try {
      const value: unknown = JSON.parse(bytes.subarray(0, stat.size).toString('utf8'))
      return record(value) ? value : {}
    } finally {
      bytes.fill(0)
    }
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {}
    throw new Error('账号配置文件不可用')
  } finally {
    bytes?.fill(0)
    await file?.close()
  }
}

/** Disable inherited SDK credentials and cross-CLI plugin imports in the native MiMo provider resolver. */
export function firstPartyEnvironment(cli: string): Record<string, string> {
  if (cli !== 'mimo') return {}
  return {
    MIMOCODE_DISABLE_PROVIDER_ENV: '1',
    MIMOCODE_DISABLE_DEFAULT_PLUGINS: '1',
    MIMOCODE_PURE: '1',
    MIMOCODE_DISABLE_MODELS_FETCH: '1',
    MIMOCODE_AUTH_CONTENT: '',
  }
}

export function parseKimiModelSources(raw: unknown, sourceId: string): FirstPartyModelSource[] {
  if (!record(raw) || !record(raw.providers) || !record(raw.models)) return []
  const sources: FirstPartyModelSource[] = []
  for (const [alias, model] of Object.entries(raw.models)) {
    if (!id(alias) || !record(model) || !id(model.model) || typeof model.provider !== 'string') continue
    const provider = raw.providers[model.provider]
    if (
      !record(provider) ||
      provider.oauth ||
      model.oauth ||
      model.providerId ||
      model.apiKey ||
      model.baseUrl
    )
      continue
    const key =
      typeof provider.apiKey === 'string' && provider.apiKey.length
        ? provider.apiKey
        : provider.env?.KIMI_API_KEY
    const protocol = model.protocol ?? provider.protocol ?? provider.type
    if (
      !literal(key) ||
      !literal(provider.baseUrl) ||
      !['openai', 'openai_responses', 'anthropic', 'kimi'].includes(protocol)
    )
      continue
    if (authHeaders(provider.customHeaders) || authHeaders(model.customHeaders)) continue
    sources.push({
      provider: model.provider,
      credential: { type: 'api', key },
      baseUrl: provider.baseUrl,
      apiType:
        provider.type !== 'kimi' && protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      sourceIds: [sourceId, `provider:${model.provider}`],
      nativeModels: [
        {
          remoteId: model.model,
          choice: {
            id: alias,
            label: typeof model.displayName === 'string' ? model.displayName : alias,
            efforts: ['default'],
          },
        },
      ],
    })
  }
  return sources
}

/** MiMo's verbose records are capability metadata, not an account allow-list. */
export function parseMimoModelRecords(output: string): Record<string, any>[] {
  const records: Record<string, any>[] = []
  let route = '',
    pending = ''
  for (const line of output.split(/\r?\n/)) {
    if (!pending && !route && !line.trim()) continue
    if (!pending && !route) {
      if (!id(line.trim()) || !line.includes('/')) throw new Error('MiMo 模型目录格式无效')
      route = line.trim()
      continue
    }
    pending += line + '\n'
    let value: unknown
    try {
      value = JSON.parse(pending)
    } catch {
      continue
    }
    if (!record(value) || `${value.providerID}/${value.id}` !== route) throw new Error('MiMo 模型身份不匹配')
    records.push(value)
    route = ''
    pending = ''
  }
  if (route || pending) throw new Error('MiMo 模型目录不完整')
  return records
}
export function mimoModelSources(
  raw: Record<string, any>[],
  config: Record<string, any>,
  auth: Record<string, any>,
  sourceId: string,
  ownInline: Record<string, { key: string; sourceId: string }> = {},
): FirstPartyModelSource[] {
  const sources: FirstPartyModelSource[] = []
  for (const model of raw) {
    const provider = model.providerID,
      options = config.provider?.[provider]?.options ?? {},
      inline = ownInline[provider],
      credential =
        options.apiKey === undefined
          ? auth[provider]
          : inline?.key === options.apiKey
            ? { type: 'api', key: inline.key }
            : undefined
    if (
      !id(provider) ||
      !id(model.id) ||
      !record(credential) ||
      credential.type !== 'api' ||
      !literal(credential.key)
    )
      continue
    if (
      config.disabled_providers?.includes(provider) ||
      (Array.isArray(config.enabled_providers) && !config.enabled_providers.includes(provider))
    )
      continue
    // Resolved keys must also occur literally in this CLI's own config; expanded foreign refs are rejected.
    if (authHeaders(options.headers) || authHeaders(model.headers)) continue
    const api = model.api
    if (
      !record(api) ||
      !id(api.id) ||
      !['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/anthropic'].includes(api.npm)
    )
      continue
    const baseUrl = options.baseURL ?? api.url
    if (!literal(baseUrl)) continue
    sources.push({
      provider,
      credential: { type: 'api', key: credential.key },
      baseUrl,
      apiType: api.npm === '@ai-sdk/anthropic' ? 'anthropic-messages' : 'openai-completions',
      sourceIds: [options.apiKey === undefined ? sourceId : inline!.sourceId, `provider:${provider}`],
      nativeModels: [
        {
          remoteId: api.id,
          choice: {
            id: `${provider}/${model.id}`,
            label: typeof model.name === 'string' ? model.name : `${provider}/${model.id}`,
            efforts: [
              'default',
              ...EFFORTS.filter(
                (e) => e !== 'default' && record(model.variants?.[e]) && model.variants[e].disabled !== true,
              ),
            ],
          },
        },
      ],
    })
  }
  return sources
}

export async function readFirstPartyModelSources(
  cli: 'kimi' | 'claude' | 'mimo',
  executable: string,
  project: string,
  capture: Capture,
  signal: AbortSignal,
): Promise<FirstPartyModelSource[]> {
  signal.throwIfAborted()
  if (cli === 'kimi') {
    if (
      ['KIMI_CODE_BASE_URL', 'KIMI_CODE_OAUTH_HOST', 'KIMI_OAUTH_HOST', 'KIMI_CODE_CUSTOM_HEADERS'].some(
        (key) => process.env[key],
      )
    )
      return []
    const raw = parseMetadata(await capture([executable, 'provider', 'list', '--json']))
    signal.throwIfAborted()
    return parseKimiModelSources(
      raw,
      join(process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'), 'config.toml'),
    )
  }
  if (cli === 'mimo') {
    const env = firstPartyEnvironment(cli)
    const paths = await capture([executable, 'debug', 'paths'], env)
    signal.throwIfAborted()
    const data = paths.match(/^data\s+(.+)$/m)?.[1]?.trim()
    if (!data || !isAbsolute(data) || dirname(data) === data) return []
    const authPath = join(data, 'auth.json'),
      auth = await readFirstPartyJson(authPath)
    signal.throwIfAborted()
    const config = parseMetadata(await capture([executable, 'debug', 'config'], env))
    signal.throwIfAborted()
    const configRoot = paths.match(/^config\s+(.+)$/m)?.[1]?.trim()
    const candidates = new Set<string>()
    if (configRoot && isAbsolute(configRoot))
      for (const name of ['config.json', 'mimocode.json']) candidates.add(join(configRoot, name))
    for (let directory = project; isAbsolute(directory); ) {
      candidates.add(join(directory, 'mimocode.json'))
      candidates.add(join(directory, '.mimocode/mimocode.json'))
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    const inline: Record<string, { key: string; sourceId: string }> = {}
    for (const path of candidates) {
      const raw = await readFirstPartyJson(path)
      signal.throwIfAborted()
      if (!record(raw.provider)) continue
      for (const [provider, value] of Object.entries(raw.provider)) {
        const key = record(value) ? value.options?.apiKey : undefined
        if (literal(key) && key === config.provider?.[provider]?.options?.apiKey)
          inline[provider] = { key, sourceId: path }
      }
    }
    if (
      !Object.values(auth).some((value) => record(value) && value.type === 'api' && literal(value.key)) &&
      !Object.keys(inline).length
    )
      return []
    const native = parseMimoModelRecords(await capture([executable, 'models', '--verbose'], env))
    signal.throwIfAborted()
    return mimoModelSources(native, config, auth, authPath, inline)
  }
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const paths = [
    join(root, 'settings.json'),
    join(project, '.claude/settings.json'),
    join(project, '.claude/settings.local.json'),
  ]
  const configured: Record<string, any> = {},
    env: Record<string, any> = {}
  for (const path of paths) {
    const settings = await readFirstPartyJson(path)
    signal.throwIfAborted()
    Object.assign(configured, settings)
    if (record(settings.env)) Object.assign(env, settings.env)
  }
  const managed = await readFirstPartyJson(
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : '/etc/claude-code/managed-settings.json',
  )
  const authOption = /ANTHROPIC|CLAUDE_CODE_(?:OAUTH|USE_|API)|AWS_|GOOGLE_|CLOUD_ML|API_KEY|BEARER_TOKEN/
  if (Object.entries(process.env).some(([key, value]) => value && authOption.test(key))) return []
  if (
    configured.apiKeyHelper ||
    managed.apiKeyHelper ||
    (record(managed.env) && Object.keys(managed.env).some((key) => authOption.test(key)))
  )
    return []
  if (
    Object.entries(env).some(
      ([key, value]) =>
        value && authOption.test(key) && !['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'].includes(key),
    )
  )
    return []
  if (!literal(env.ANTHROPIC_API_KEY)) return []
  const status = parseMetadata(await capture([executable, 'auth', 'status', '--json']))
  signal.throwIfAborted()
  if (!record(status) || status.loggedIn !== true || status.authMethod !== 'api_key') return []
  const help = await capture([executable, '--help'])
  signal.throwIfAborted()
  if (!help.includes('--model') || !help.includes('--output-format'))
    throw new Error('Claude 版本不支持模型参数，请升级')
  return [
    {
      provider: 'anthropic',
      credential: { type: 'api', key: env.ANTHROPIC_API_KEY },
      baseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      apiType: 'anthropic-messages',
      sourceIds: paths,
      nativeModels: [],
      nativeFullModelIds: true,
    },
  ]
}

export async function discoverFirstPartySources(
  sources: FirstPartyModelSource[],
  signal: AbortSignal,
  options: Parameters<typeof probeAccountModels>[1] = {},
): Promise<ModelChoice[]> {
  const models = new Map<string, ModelChoice>(),
    scopes = new Map<string, Awaited<ReturnType<typeof probeAccountModels>>>()
  for (const source of sources) {
    signal.throwIfAborted()
    const route = JSON.stringify([source.provider, source.baseUrl, source.apiType, source.credential])
    let scope = scopes.get(route)
    if (!scope) {
      scope = await probeAccountModels(source, { ...options, signal })
      scopes.set(route, scope)
    }
    signal.throwIfAborted()
    if (scope.state !== 'supported') continue
    const nativeModels = source.nativeFullModelIds
      ? scope.models
          .filter((model) => id(model.id) && !['sonnet', 'opus', 'haiku'].includes(model.id))
          .map((model) => ({
            remoteId: model.id,
            choice: {
              id: model.id,
              label: model.name ?? model.id,
              efforts: ['default'] as ModelChoice['efforts'],
            },
          }))
      : source.nativeModels
    for (const { remoteId, choice } of nativeModels) {
      const available = scope.models.find((model) => model.id === remoteId)
      if (available) models.set(choice.id, { ...choice, cost: available.cost })
    }
  }
  return [...models.values()]
}
