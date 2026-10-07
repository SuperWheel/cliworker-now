import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { EFFORTS, type ModelChoice, type TaskMode } from '../shared/types.ts'
import type { EventInput, ProtocolResult } from './protocol.ts'
import {
  activeOpenCodeCredential,
  readOpenCodeProfile,
  snapshotOpenCodeAuth,
  type OpenCodeNativeOptions,
} from './opencode-native.ts'
import { probeAccountModels, type AccountModelScope } from './account-models.mjs'

export interface OpenCodeInput {
  executable: string
  project: string
  preference: { model: string; effort: string }
  mode: TaskMode
  prompt: string
  conversationId?: string
  stateDirectory: string
  /** Stable private XDG data root shared with account login, not worker databases. */
  authDirectory?: string
  /** Host-managed API references must not silently fall back to native credentials. */
  managedCredentials?: boolean
  nativeHome?: string
  modelsPath?: string
}
type Capture = (argv: string[], env?: Record<string, string>) => Promise<string>
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const modelID = (id: string) => /^[A-Za-z0-9_.:-]+\/[^\s\x00-\x1f]+$/.test(id)
const sessionID = (id: string) => /^ses_[A-Za-z0-9]+$/.test(id)

export interface OpenCodeCredentialConfig {
  zaiCredentialRef?: string
  resolveCredential?: (ref: string) => Promise<string | undefined>
}
/** Managed refs are an explicit source, never a fallback to unrelated native auth. */
export async function openCodeCredentialEnvironment(
  config: OpenCodeCredentialConfig,
): Promise<Record<string, string>> {
  if (!config.zaiCredentialRef) return {}
  let key: string | undefined
  try {
    key = await config.resolveCredential?.(config.zaiCredentialRef)
  } catch {
    throw new Error('OpenCode 的 Harness 凭据引用不可用，请在原生模型设置中配置')
  }
  if (!key) throw new Error('OpenCode 的 Harness 凭据引用不可用，请在原生模型设置中配置')
  return { ZHIPU_API_KEY: key }
}

export function openCodeAuthDirectory(stateDirectory?: string): string {
  return join(
    stateDirectory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
    'accounts',
    'opencode',
    'data',
  )
}

/** Only the auth data root is shared; each process keeps its own DB/config/cache. */
export async function openCodeEnvironment(
  stateDirectory: string,
  config: Record<string, unknown>,
  authDirectory = join(stateDirectory, 'data'),
  managedCredentials = false,
  modelsPath?: string,
) {
  if (!isAbsolute(stateDirectory) || !isAbsolute(authDirectory))
    throw new Error('OpenCode state and auth directories must be absolute')
  const paths = ['config', 'data', 'cache', 'state', 'tmp'].map((name) => join(stateDirectory, name))
  for (const path of [stateDirectory, ...paths, authDirectory, join(authDirectory, 'opencode')]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('OpenCode state directory must not be a symlink')
    await chmod(path, 0o700)
  }
  const configFile = join(stateDirectory, 'config', 'cliworker.json')
  const { provider, ...inline } = config
  const temporary = join(stateDirectory, 'config', `.cliworker-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(provider ? { provider } : {}) + '\n', {
      flag: 'wx',
      mode: 0o600,
    })
    // Replace an existing link itself, rather than following it from the unsandboxed Host.
    await rename(temporary, configFile)
  } finally {
    await rm(temporary, { force: true })
  }
  const nativeModels = modelsPath ?? join(homedir(), '.cache', 'opencode', 'models.json')
  return {
    XDG_CONFIG_HOME: paths[0]!,
    XDG_DATA_HOME: authDirectory,
    XDG_CACHE_HOME: paths[2]!,
    XDG_STATE_HOME: paths[3]!,
    TMPDIR: paths[4]!,
    OPENCODE_DB: join(stateDirectory, 'data', 'opencode.db'),
    OPENCODE_CONFIG: configFile,
    OPENCODE_CONFIG_DIR: paths[0]!,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      plugin: [],
      mcp: {},
      lsp: false,
      formatter: false,
      ...inline,
    }),
    OPENCODE_PERMISSION: JSON.stringify(config.permission ?? { '*': 'deny' }),
    OPENCODE_AUTO_SHARE: '0',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PRUNE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    // Native OAuth refresh hooks are built-ins. External plugins remain disabled.
    OPENCODE_DISABLE_DEFAULT_PLUGINS: managedCredentials ? '1' : '0',
    // Clear inherited overrides; native mode reads the same private auth.json as login.
    OPENCODE_AUTH_CONTENT: managedCredentials ? '{}' : '',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
    OPENCODE_PURE: '1',
    ...(existsSync(nativeModels) ? { OPENCODE_MODELS_PATH: nativeModels } : {}),
  }
}

export async function prepareOpenCode(
  input: OpenCodeInput,
): Promise<{ argv: string[]; env: Record<string, string> }> {
  const { executable, project, preference, mode, prompt, conversationId, stateDirectory } = input
  if (!modelID(preference.model)) throw new Error('OpenCode requires an explicitly selected provider/model')
  if (!EFFORTS.includes(preference.effort as any)) throw new Error('Unsupported OpenCode effort value')
  if (!isAbsolute(project) || !prompt.trim()) throw new Error('OpenCode requires a project and prompt')
  if (mode !== 'plan' && mode !== 'accept-edits') throw new Error('Unsupported OpenCode task mode')
  if (conversationId && !sessionID(conversationId)) throw new Error('Invalid native OpenCode session ID')
  const selectedProvider = preference.model.slice(0, preference.model.indexOf('/'))
  if (input.managedCredentials && selectedProvider !== 'zhipuai-coding-plan')
    throw new Error('OpenCode 的 Host 智谱引用仅用于原生 CN Coding Plan 提供商')
  const source = input.authDirectory ?? openCodeAuthDirectory()
  const profile = input.managedCredentials ? undefined : await readOpenCodeProfile(source, input)
  if (profile && !activeOpenCodeCredential(profile.auth[selectedProvider]))
    throw new Error('OpenCode 所选提供商没有有效账号配置，请先登录')
  const snapshot = profile ? await snapshotOpenCodeAuth(source, profile.auth, [selectedProvider]) : source
  const env = await openCodeEnvironment(
    stateDirectory,
    {
      model: preference.model,
      small_model: preference.model,
      enabled_providers: [selectedProvider],
      ...(profile?.providers[selectedProvider]
        ? { provider: { [selectedProvider]: profile.providers[selectedProvider] } }
        : {}),
      permission: {
        '*': 'ask',
        read: 'allow',
        glob: 'allow',
        grep: 'allow',
        list: 'allow',
        edit: mode === 'plan' ? 'deny' : 'allow',
        bash: mode === 'plan' ? 'deny' : 'ask',
        task: 'deny',
        skill: 'deny',
        question: 'deny',
      },
    },
    snapshot,
    input.managedCredentials,
    profile?.modelsPath,
  )
  return {
    argv: [
      executable,
      'run',
      '--format',
      'json',
      '--model',
      preference.model,
      '--agent',
      mode === 'plan' ? 'plan' : 'build',
      '--dir',
      project,
      '--title',
      'CLI Worker',
      ...(preference.effort !== 'default' ? ['--variant', preference.effort] : []),
      ...(conversationId ? ['--session', conversationId] : []),
      '--',
      prompt,
    ],
    env,
  }
}

/** Native models --verbose consists of provider/model lines and pretty JSON objects. */
function parseOpenCodeRecords(output: string): { choice: ModelChoice; native: Record<string, any> }[] {
  if (Buffer.byteLength(output) > 4_194_304) throw new Error('OpenCode model catalogue exceeds limit')
  const models: { choice: ModelChoice; native: Record<string, any> }[] = [],
    ids = new Set<string>()
  let id = '',
    pending = ''
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!pending && !line) continue
    if (!pending && !id) {
      if (!modelID(line)) throw new Error('Invalid OpenCode model catalogue entry')
      id = line
      continue
    }
    pending += raw + '\n'
    let model: unknown
    try {
      model = JSON.parse(pending)
    } catch {
      continue
    }
    if (
      !object(model) ||
      typeof model.id !== 'string' ||
      typeof model.providerID !== 'string' ||
      `${model.providerID}/${model.id}` !== id
    )
      throw new Error('OpenCode model identity does not match its catalogue entry')
    if (ids.has(id)) {
      id = ''
      pending = ''
      continue
    }
    if (model.variants !== undefined && !object(model.variants))
      throw new Error('Invalid OpenCode model variants')
    ids.add(id)
    models.push({
      native: model,
      choice: {
        id,
        label: typeof model.name === 'string' ? model.name : id,
        efforts: [
          'default',
          ...EFFORTS.filter((effort) => effort !== 'default' && Object.hasOwn(model.variants ?? {}, effort)),
        ],
      },
    })
    id = ''
    pending = ''
  }
  if (id || pending) throw new Error('Incomplete OpenCode model catalogue')
  return models
}

/** CLI default zero prices are not affirmative price evidence. */
export function parseOpenCodeModels(output: string): ModelChoice[] {
  return parseOpenCodeRecords(output).map(({ choice }) => ({ ...choice, cost: 'unknown' }))
}
export interface OpenCodeDiscoveryOptions extends OpenCodeNativeOptions {
  credentialEnv?: Record<string, string>
  probeOptions?: Parameters<typeof probeAccountModels>[1]
}
function configuredCost(value: unknown): ModelChoice['cost'] {
  if (!object(value)) return 'unknown'
  const cost = value.cost ?? value.pricing
  if (object(cost)) {
    const number = (rate: unknown) =>
      typeof rate === 'number'
        ? rate
        : typeof rate === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rate)
          ? Number(rate)
          : NaN
    const input = number(cost.input),
      output = number(cost.output)
    const additional = Object.entries(cost)
      .filter(([key]) => !['input', 'output', 'free'].includes(key))
      .flatMap(([, rate]) => (object(rate) ? Object.values(rate).map(number) : [number(rate)]))
    if (input > 0 || output > 0 || additional.some((rate) => rate > 0)) return 'paid'
    if (
      !Number.isFinite(input) ||
      !Number.isFinite(output) ||
      input < 0 ||
      output < 0 ||
      additional.some((rate) => !Number.isFinite(rate) || rate < 0)
    )
      return 'unknown'
    return 'free'
  }
  return value.free === true || value.is_free === true ? 'free' : 'unknown'
}
export async function discoverOpenCode(
  executable: string,
  capture: Capture,
  stateDirectory: string,
  authDirectory?: string,
  managedCredentials = false,
  options: OpenCodeDiscoveryOptions = {},
): Promise<ModelChoice[]> {
  options.signal?.throwIfAborted()
  const source = authDirectory ?? openCodeAuthDirectory()
  const profile = await readOpenCodeProfile(source, options)
  const cnKey = options.credentialEnv?.ZHIPU_API_KEY
  const cn = managedCredentials && typeof cnKey === 'string' && !!cnKey.trim()
  if (cn) profile.auth['zhipuai-coding-plan'] = { type: 'api', key: cnKey }
  const providers = Object.keys(profile.auth).filter(
    (id) =>
      activeOpenCodeCredential(profile.auth[id]) &&
      !profile.disabled.includes(id) &&
      (!profile.enabled || profile.enabled.includes(id)) &&
      !(id === 'opencode' && profile.auth[id].key === 'public'),
  )
  if (!providers.length) return []
  const snapshot = await snapshotOpenCodeAuth(
    source,
    profile.auth,
    providers.filter((id) => !(cn && id === 'zhipuai-coding-plan')),
    options.signal,
  )
  const nativeProviderConfig = Object.fromEntries(
    providers
      .filter((id) => profile.providers[id] && !(cn && id === 'zhipuai-coding-plan'))
      .map((id) => [id, profile.providers[id]]),
  )
  const env = await openCodeEnvironment(
    stateDirectory,
    {
      enabled_providers: providers,
      provider: nativeProviderConfig,
      permission: { '*': 'deny' },
    },
    snapshot,
    false,
    profile.modelsPath,
  )
  const records = parseOpenCodeRecords(
    await capture([executable, 'models', '--verbose'], { ...env, ...(cn ? { ZHIPU_API_KEY: cnKey! } : {}) }),
  )
  options.signal?.throwIfAborted()
  const scoped = (native: Record<string, any>) => {
    const provider = native.providerID,
      config = profile.providers[provider] ?? {}
    const managed = cn && provider === 'zhipuai-coding-plan'
    const oauthCodex = profile.auth[provider]?.type === 'oauth' && provider === 'openai'
    const baseUrl = oauthCodex
      ? 'https://chatgpt.com/backend-api'
      : managed
        ? 'https://open.bigmodel.cn/api/coding/paas/v4'
        : (config.options?.baseURL ?? native.api?.url ?? profile.catalog[provider]?.api)
    const apiType = !managed && native.api?.npm === '@ai-sdk/anthropic' ? 'anthropic-messages' : undefined
    const oauth = profile.auth[provider]?.type === 'oauth'
    const key = JSON.stringify([provider, oauth ? 'oauth-account' : baseUrl, oauth ? '' : apiType])
    const authHeader = (headers: unknown) =>
      object(headers) &&
      Object.keys(headers).some((name) =>
        /authorization|api[-_]?key|token|cookie|openai-organization|openai-project/i.test(name),
      )
    const blocked =
      !managed &&
      (authHeader(native.headers) ||
        authHeader(config.options?.headers) ||
        (oauthCodex && native.api?.npm !== '@ai-sdk/openai'))
    return { provider, baseUrl, apiType, key, blocked }
  }
  const groups = new Map<string, { route: ReturnType<typeof scoped>; entries: typeof records }>()
  for (const entry of records) {
    const route = scoped(entry.native)
    if (route.blocked || !providers.includes(route.provider)) continue
    const group = groups.get(route.key) ?? { route, entries: [] }
    group.entries.push(entry)
    groups.set(route.key, group)
  }
  const scopes = new Map<string, AccountModelScope>()
  await Promise.all(
    [...groups.values()].map(async ({ route, entries }) => {
      const { provider, baseUrl, apiType, key } = route,
        auth = profile.auth[provider],
        config = profile.providers[provider] ?? {}
      const explicit = entries
        .filter(({ native }) => object(config.models?.[native.id]) || config.whitelist?.includes(native.id))
        .map(({ native }) => native.api?.id ?? native.id)
      const scope = await probeAccountModels(
        {
          provider,
          credential:
            auth.type === 'oauth'
              ? { type: 'oauth', access: auth.access, expires: auth.expires, accountId: auth.accountId }
              : { type: 'api', key: auth.key },
          baseUrl,
          apiType,
          customModelIds: cn && provider === 'zhipuai-coding-plan' ? [] : [...new Set(explicit)],
          verifiedModelIds: [],
        },
        { ...options.probeOptions, signal: options.signal ?? options.probeOptions?.signal },
      )
      scopes.set(key, scope)
    }),
  )
  options.signal?.throwIfAborted()
  const models: ModelChoice[] = []
  for (const { choice, native } of records) {
    const route = scoped(native)
    if (route.blocked) continue
    const scope = scopes.get(route.key)
    if (scope?.state !== 'supported') continue
    const apiId = native.api?.id ?? native.id
    const supported = scope.models.find((model) => model.id === apiId || model.id === native.id)
    if (!supported) continue
    const secrets = [
      profile.auth[native.providerID]?.key,
      profile.auth[native.providerID]?.access,
      profile.auth[native.providerID]?.refresh,
      cnKey,
    ].filter((value): value is string => typeof value === 'string' && !!value)
    if (secrets.some((secret) => choice.id.includes(secret) || String(apiId).includes(secret))) continue
    const explicit = profile.providers[native.providerID]?.models?.[native.id]
    const declaredCost =
      explicit === undefined
        ? configuredCost(profile.catalog[native.providerID]?.models?.[apiId])
        : configuredCost(explicit)
    const subscription = native.providerID.includes('coding-plan') || native.providerID === 'opencode-go'
    const cost =
      subscription && profile.auth[native.providerID]?.type === 'api'
        ? supported.cost === 'paid'
          ? 'paid'
          : 'unknown'
        : supported.cost !== 'unknown'
          ? supported.cost
          : profile.auth[native.providerID]?.type === 'oauth' || subscription
            ? 'unknown'
            : declaredCost
    // Zen's anonymous free loader is not an account. Even with a key, a zero-price
    // public route has no affirmative headless compatibility evidence in 1.18.21.
    const endpoint =
      profile.providers[native.providerID]?.options?.baseURL ??
      native.api?.url ??
      profile.catalog[native.providerID]?.api
    let zen = false
    try {
      zen = new URL(endpoint).hostname === 'opencode.ai'
    } catch {
      /* unknown endpoints are not proof of a Zen route */
    }
    if (native.providerID === 'opencode' && zen && (native.cost?.input === 0 || cost === 'free')) continue
    models.push({
      ...choice,
      label: secrets.some((secret) => choice.label.includes(secret)) ? native.id : choice.label,
      cost,
    })
  }
  return models.sort(
    (a, b) => Number(b.cost === 'free') - Number(a.cost === 'free') || a.id.localeCompare(b.id),
  )
}

/** Native OpenCode JSONL; success needs clean EOF after stop, identity and no failed tool. */
export class OpenCodeProtocol {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private ended = false
  private stopped = false
  private sawStep = false
  private failure?: string
  private response = ''
  private steps = new Map<string, number>()
  private textParts = new Map<string, string>()
  private openTools = new Set<string>()
  conversationId?: string
  result?: ProtocolResult
  constructor(
    private emit: (event: EventInput) => void,
    private identify: (id: string) => void,
    private maxLineBytes: number,
  ) {}
  feed(chunk: Buffer | string): void {
    if (this.ended) throw new Error('OpenCode event received after EOF')
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    let newline: number
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).trim()
      this.pending = this.pending.slice(newline + 1)
      if (line) this.line(line)
    }
    if (Buffer.byteLength(this.pending) > this.maxLineBytes)
      throw new Error('OpenCode event exceeds maxLineBytes')
  }
  end(): void {
    if (this.ended) return
    this.pending += this.decoder.end()
    if (this.pending.trim()) this.line(this.pending.trim())
    this.pending = ''
    this.ended = true
    if (!this.conversationId) return
    if (!this.failure && !(this.stopped && this.sawStep && this.openTools.size === 0)) return
    const status = this.failure ? 'ERROR' : 'SUCCESS'
    this.result = {
      conversationId: this.conversationId,
      status,
      response: this.response,
      ...(this.failure ? { error: this.failure } : {}),
    }
    this.emit({ kind: 'result', text: this.response, state: status })
  }
  private step(id: string) {
    if (!this.steps.has(id)) this.steps.set(id, this.steps.size)
    return this.steps.get(id)!
  }
  private id(value: unknown) {
    if (value === undefined) return
    if (typeof value !== 'string' || !sessionID(value)) throw new Error('Invalid OpenCode session ID')
    if (this.conversationId && this.conversationId !== value)
      throw new Error('OpenCode session ID changed during a run')
    if (!this.conversationId) {
      this.identify(value)
      this.conversationId = value
    }
  }
  private line(line: string) {
    if (Buffer.byteLength(line) > this.maxLineBytes) throw new Error('OpenCode event exceeds maxLineBytes')
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error('Invalid OpenCode JSONL event')
    }
    if (!object(event) || typeof event.type !== 'string') throw new Error('Invalid OpenCode event envelope')
    this.id(event.sessionID)
    const part = object(event.part) ? event.part : undefined
    if (part) this.id(part.sessionID)
    if (this.stopped && event.type !== 'error') throw new Error('Unexpected OpenCode event after final stop')
    if (event.type === 'step_start') {
      this.sawStep = true
      this.emit({ kind: 'status', text: 'OpenCode 工作中' })
    } else if (event.type === 'text') {
      if (!part || typeof part.id !== 'string' || typeof part.text !== 'string')
        throw new Error('Invalid OpenCode text part')
      const previous = this.textParts.get(part.id)
      if (previous !== undefined) {
        if (previous !== part.text) throw new Error('OpenCode text part changed after completion')
        return
      }
      this.textParts.set(part.id, part.text)
      this.response = part.text
      this.emit({ kind: 'assistant', step: this.step(part.id), text: part.text })
    } else if (event.type === 'tool_use') {
      if (!part || typeof part.tool !== 'string' || !object(part.state))
        throw new Error('Invalid OpenCode tool event')
      const id = part.callID ?? part.id,
        state = part.state.status
      if (typeof id !== 'string' || !['pending', 'running', 'completed', 'error'].includes(state))
        throw new Error('Invalid OpenCode tool state')
      if (state === 'completed' || state === 'error') this.openTools.delete(id)
      else this.openTools.add(id)
      if (state === 'error')
        this.failure ??=
          typeof part.state.error === 'string' ? part.state.error : 'OpenCode 工具执行失败或权限被拒绝'
      this.emit({
        kind: 'tool',
        step: this.step(id),
        text: part.tool,
        detail: JSON.stringify(part.state),
        state: state === 'error' ? 'FAILED' : state === 'completed' ? 'COMPLETED' : 'RUNNING',
      })
    } else if (event.type === 'step_finish') {
      if (!part || typeof part.reason !== 'string' || !this.sawStep)
        throw new Error('Invalid OpenCode step finish')
      this.stopped = part.reason === 'stop'
      if (!['stop', 'tool-calls'].includes(part.reason))
        this.failure ??= `OpenCode 未正常完成：${part.reason}`
    } else if (event.type === 'error') {
      const message: string =
        typeof event.error?.data?.message === 'string'
          ? event.error.data.message
          : (JSON.stringify(event.error ?? 'OpenCode error') ?? 'OpenCode error')
      this.failure = message
      this.emit({ kind: 'diagnostic', text: message })
    } else {
      if (
        event.type === 'permission.asked' ||
        (event.type === 'permission.replied' && event.properties?.reply === 'reject')
      )
        this.failure ??= 'OpenCode 需要额外授权，未执行的操作不能视为完成'
      if (event.type !== 'reasoning')
        this.emit({ kind: 'diagnostic', text: `OpenCode 事件：${event.type}`, detail: line })
    }
  }
}
