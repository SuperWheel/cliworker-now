import { createHash } from 'node:crypto'
import type { Effort } from '../shared/types.ts'
import type { AccountModelScope } from './account-models.mjs'
import { accountEmail } from './account-identity.ts'

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= 32768 && !/[\x00-\x20\x7f]/.test(value)
export const NOUS_PORTAL = 'https://portal.nousresearch.com'
export const NOUS_INFERENCE = 'https://inference-api.nousresearch.com/v1'
const canonical = (value: unknown, expected: string) =>
  typeof value === 'string' && value.replace(/\/+$/, '') === expected

export class HermesNousError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HermesNousError'
  }
}
const invalid = (): never => {
  throw new HermesNousError('Nous 当前账号无法确认，请在 Hermes 登录设置中检查')
}

/** Unsigned native JWT claims are local identity/expiry metadata, never remote proof. */
function claims(token: unknown): Record<string, any> {
  if (!text(token) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return {}
  const bytes = Buffer.from(token.split('.')[1]!, 'base64url')
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    return object(value) ? value : {}
  } catch {
    return {}
  } finally {
    bytes.fill(0)
  }
}
function scopes(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/[\s,]+/) : Array.isArray(value) ? value.flatMap(scopes) : []
}
function unavailable(row: Record<string, any>): boolean {
  if (row.disabled === true || row.status === 'exhausted' || row.last_status === 'dead') return true
  if (row.last_status === 'exhausted') {
    const until = Number(row.last_error_reset_at)
    if (!Number.isFinite(until) || until <= 0 || until > Date.now() / 1000) return true
  }
  return false
}

export interface HermesNousSource {
  /** Host only. Never serialize this object in a public response or on disk. */
  access: string
  agentKey: string
  expires: number
  email?: string
  principal: { kind: 'oauth'; subject: string; organization: string; issuer: string; clientId?: string }
  route: { portal: string; inference: string; anthropicWire?: string }
  paidAccess?: boolean
  modelCooldowns: Record<string, unknown>[]
}

/** Hermes 6c80c327: flat providers.nous, native device-code pool and invoke JWT.
 * No refresh-only, guest, fallback store or different pooled principal is promoted. */
export function projectHermesNousSource(auth: any, minTtlSeconds = 0): HermesNousSource {
  const state = auth?.providers?.nous
  if (
    !object(state) ||
    auth.active_provider !== 'nous' ||
    state.auth_method === 'anonymous' ||
    state.account_tier === 'anonymous' ||
    state.last_auth_error?.relogin_required === true ||
    unavailable(state)
  )
    invalid()
  const access = state.access_token,
    agentKey = state.agent_key
  const token = claims(agentKey)
  if (
    !text(access) ||
    !text(agentKey) ||
    access !== agentKey ||
    token.account_tier === 'anonymous' ||
    !text(token.sub) ||
    !text(token.org_id) ||
    !text(token.iss) ||
    typeof token.exp !== 'number' ||
    !Number.isFinite(token.exp) ||
    ![...scopes(state.scope), ...scopes(token.scope), ...scopes(token.scp)].includes('inference:invoke')
  )
    invalid()
  if (token.exp * 1000 <= Date.now() + minTtlSeconds * 1000)
    throw new HermesNousError('Nous 登录即将过期或已过期，请在 Hermes 登录设置中重新登录')
  if (!canonical(state.portal_base_url, NOUS_PORTAL) || !canonical(state.inference_base_url, NOUS_INFERENCE))
    throw new HermesNousError('Nous 当前路由暂不支持账号模型查询')
  const pool = auth.credential_pool?.nous ?? []
  if (
    !Array.isArray(pool) ||
    pool.length > 8 ||
    pool.some(
      (row) =>
        !object(row) ||
        row.auth_type !== 'oauth' ||
        !['device_code', 'manual:device_code'].includes(row.source) ||
        row.access_token !== access ||
        row.agent_key !== agentKey ||
        unavailable(row) ||
        (row.portal_base_url && !canonical(row.portal_base_url, NOUS_PORTAL)) ||
        (row.inference_base_url && !canonical(row.inference_base_url, NOUS_INFERENCE)) ||
        (row.base_url && !canonical(row.base_url, NOUS_INFERENCE)),
    )
  )
    invalid()
  return {
    access,
    agentKey,
    expires: token.exp * 1000,
    email: accountEmail(token.email),
    principal: {
      kind: 'oauth',
      subject: token.sub,
      organization: token.org_id,
      issuer: token.iss,
      ...(text(token.client_id) ? { clientId: token.client_id } : {}),
    },
    route: { portal: NOUS_PORTAL, inference: NOUS_INFERENCE },
    ...(typeof token.paid_access === 'boolean' ? { paidAccess: token.paid_access } : {}),
    modelCooldowns: pool.map((row: any) => (object(row.model_cooldowns) ? row.model_cooldowns : {})),
  }
}

export function hermesNousMinimumTtl(env: Record<string, string>): number {
  const setting = env.HERMES_NOUS_MIN_KEY_TTL_SECONDS
  const ttl = setting === undefined ? 120 : /^\d+$/.test(setting) ? Math.max(120, Number(setting)) : NaN
  if (!Number.isFinite(ttl)) invalid()
  return ttl
}

/** Runtime uses its supported MIN_KEY_TTL override (120s), matching the native
 * invoke-JWT skew. The native default 1800s is a proactive-refresh optimization,
 * not invalid-account evidence. An explicit own-home setting still takes precedence. */
export function selectHermesNousSource(material: {
  config: any
  auth: any
  env: Record<string, string>
}): HermesNousSource {
  const { config, auth, env } = material
  const cfg = config.model
  if (!object(cfg) || cfg.provider !== 'nous' || config.providers?.nous?.enabled === false) invalid()
  if (!Array.isArray(auth.credential_pool?.nous) || !auth.credential_pool.nous.length)
    throw new HermesNousError('Nous 登录已保存，请在 Hermes 登录设置中完成原生账号初始化')
  if (
    (cfg.extra_headers && Object.keys(cfg.extra_headers).length) ||
    cfg.api_key ||
    [env.NOUS_API_KEY, env.CUSTOM_API_KEY].some(Boolean) ||
    Object.keys(env).some((key) => /^NOUS_API_KEY_\d+$/.test(key))
  )
    throw new HermesNousError('Nous 含额外认证配置，请在 Hermes 登录设置中确认当前账号')
  if (
    [cfg.base_url, env.NOUS_INFERENCE_BASE_URL, env.CUSTOM_BASE_URL].some(
      (url) => url && !canonical(url, NOUS_INFERENCE),
    ) ||
    [env.NOUS_PORTAL_BASE_URL, env.HERMES_PORTAL_BASE_URL].some(
      (url) => url && !canonical(url, NOUS_PORTAL),
    ) ||
    (cfg.api_mode && !['chat_completions', 'anthropic_messages'].includes(cfg.api_mode))
  )
    throw new HermesNousError('Nous 当前路由暂不支持账号模型查询')
  const source = projectHermesNousSource(auth, hermesNousMinimumTtl(env))
  const wire = config.nous?.anthropic_wire ?? 'chat'
  if (!['chat', 'native', 'auto'].includes(wire))
    throw new HermesNousError('Nous 当前路由暂不支持账号模型查询')
  source.route.anthropicWire = wire
  return source
}

const capabilityCache = new Map<string, { at: number; generation: symbol; models: Map<string, Effort[]> }>()
function sourceKey(home: string, source: HermesNousSource): string {
  return createHash('sha256')
    .update(JSON.stringify([home, source.principal, source.route, source.agentKey]))
    .digest('hex')
}
export function hermesNousEfforts(home: string, source: HermesNousSource, model: string): Effort[] {
  const entry = capabilityCache.get(sourceKey(home, source))
  return entry && Date.now() - entry.at < 60000 ? (entry.models.get(model) ?? ['default']) : ['default']
}
export function beginHermesNousCapabilities(home: string, source: HermesNousSource): symbol {
  const generation = Symbol()
  capabilityCache.set(sourceKey(home, source), { at: Date.now(), generation, models: new Map() })
  return generation
}
export function forgetHermesNousCapabilities(home: string, source: HermesNousSource, generation: symbol) {
  const key = sourceKey(home, source)
  if (capabilityCache.get(key)?.generation === generation) capabilityCache.delete(key)
}

const generationTypes = new Set([
  'image',
  'image_generation',
  'image-generation',
  'image-gen',
  'video',
  'video_generation',
  'video-generation',
  'video-gen',
])
const generationId =
  /(?:^|[/_.-])(?:image(?:[/_.-]gen(?:eration)?)?|video(?:[/_.-]gen(?:eration)?)?|text[/_.-]to[/_.-](?:image|video)|stable-diffusion|sdxl|flux)(?=$|[/_.-])/i
const tagsGeneration = (tags: any) =>
  Array.isArray(tags) && tags.some((tag) => generationTypes.has(String(tag).toLowerCase()))
function chatCapable(row: any): boolean {
  const outputs = row.architecture?.output_modalities
  return (
    !/hermes/i.test(row.id) &&
    !generationId.test(row.id) &&
    !generationTypes.has(String(row.type).toLowerCase()) &&
    !generationTypes.has(String(row.capabilities?.type).toLowerCase()) &&
    ![row.tags, row.capabilities?.tags, row.metadata?.tags].some(tagsGeneration) &&
    !(
      Array.isArray(outputs) &&
      outputs.some((x) => ['image', 'video'].includes(x)) &&
      !outputs.some((x) => ['text', 'chat'].includes(x))
    ) &&
    !(Array.isArray(row.supported_parameters) && !row.supported_parameters.includes('tools'))
  )
}
function cost(row: any): 'free' | 'paid' | 'unknown' {
  if (!object(row.pricing)) return 'unknown'
  const numeric = (value: any) =>
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
        ? Number(value)
        : NaN
  const prompt = numeric(row.pricing.prompt),
    completion = numeric(row.pricing.completion)
  if (![prompt, completion].every((n) => Number.isFinite(n) && n >= 0)) return 'unknown'
  // Native pricing.original is sale display metadata, not a currently charged rate.
  const extra = Object.entries(row.pricing)
    .filter(([key]) => !['prompt', 'completion', 'original'].includes(key))
    .map(([, value]) => numeric(value))
  if (extra.some((n) => !Number.isFinite(n) || n < 0)) return 'unknown'
  return [prompt, completion, ...extra].some((n) => n > 0) ? 'paid' : 'free'
}
// Native _parser accepts these levels; agent/reasoning_effort.OPENAI_COMPAT_WIRE_EFFORTS
// is the Nous transport vocabulary. `ultra` is internal and clamped, so never offer it.
const nativeNousWireEfforts = new Set<Effort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
function efforts(row: any): Effort[] {
  if (
    !Array.isArray(row.supported_parameters) ||
    !row.supported_parameters.includes('reasoning') ||
    !Array.isArray(row.reasoning?.supported_efforts)
  )
    return ['default']
  return [
    ...new Set<Effort>([
      'default',
      ...row.reasoning.supported_efforts.filter(
        (value: any): value is Effort =>
          typeof value === 'string' && nativeNousWireEfforts.has(value as Effort),
      ),
    ]),
  ]
}

async function get(
  url: string,
  token: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number },
): Promise<any> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const chunks: Uint8Array[] = []
  try {
    signal.throwIfAborted()
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!response.ok || response.redirected) {
      await response.body?.cancel()
      throw new HermesNousError(
        [401, 403].includes(response.status)
          ? 'Nous 账号权限查询被拒绝，请检查登录状态'
          : 'Nous 模型元数据查询失败，请稍后重试',
      )
    }
    reader = response.body?.getReader()
    if (!reader) throw new Error('empty')
    let length = 0
    const abort = () => {
      void reader?.cancel().catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for (;;) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        length += value.length
        if (length > 1024 * 1024) throw new Error('oversized')
        chunks.push(value)
      }
      const bytes = Buffer.concat(chunks)
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } finally {
        bytes.fill(0)
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof HermesNousError) throw error
    throw new HermesNousError(
      controller.signal.aborted
        ? 'Nous 模型元数据查询超时，请稍后重试'
        : 'Nous 模型元数据无法读取，请稍后重试',
    )
  } finally {
    clearTimeout(timeout)
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    for (const chunk of chunks) chunk.fill(0)
  }
}

/** Two read-only, authenticated native endpoints. No public fallback, retry or OAuth refresh. */
export async function fetchHermesNousModels(
  home: string,
  source: HermesNousSource,
  options: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
  generation = beginHermesNousCapabilities(home, source),
): Promise<AccountModelScope> {
  const account = await get(`${NOUS_PORTAL}/api/oauth/account`, source.access, options)
  const access = account?.paid_service_access
  const paid =
    typeof access?.allowed === 'boolean'
      ? access.allowed
      : typeof access?.paid_access === 'boolean'
        ? access.paid_access
        : undefined
  if (
    !object(account) ||
    !object(access) ||
    paid === undefined ||
    (account.organisation?.id ?? access.organisation_id) !== source.principal.organization ||
    (source.email && account.user?.email && account.user.email !== source.email) ||
    (account.user?.privy_did && account.user.privy_did !== source.principal.subject) ||
    account.account_tier === 'anonymous' ||
    account.authenticated === false ||
    account.error
  )
    throw new HermesNousError('Nous 账号权限格式无法确认，请刷新登录后重试')
  const data = await get(`${NOUS_INFERENCE}/models`, source.agentKey, options)
  if (
    !object(data) ||
    !Array.isArray(data.data) ||
    data.data.length > 10000 ||
    data.error ||
    data.authenticated === false
  )
    throw new HermesNousError('Nous 模型列表格式无法确认')
  const cap = new Map<string, Effort[]>(),
    ids = new Set<string>()
  const models: AccountModelScope['models'] = []
  for (const row of data.data) {
    if (
      !object(row) ||
      typeof row.id !== 'string' ||
      !/^[A-Za-z0-9_./:+-]{1,256}$/.test(row.id) ||
      ids.has(row.id) ||
      row.id.includes(source.agentKey) ||
      row.allowed === false ||
      row.available === false ||
      row.enabled === false ||
      row.disabled === true ||
      row.entitled === false ||
      row.upgrade_required === true ||
      !chatCapable(row) ||
      source.modelCooldowns.some(
        (cooldowns) =>
          typeof cooldowns[row.id] === 'number' && (cooldowns[row.id] as number) > Date.now() / 1000,
      )
    )
      continue
    const price = cost(row)
    if (!paid && price !== 'free') continue
    ids.add(row.id)
    models.push({ id: row.id, cost: price })
    cap.set(row.id, efforts(row))
  }
  for (const [key, entry] of capabilityCache) if (Date.now() - entry.at >= 60000) capabilityCache.delete(key)
  if (capabilityCache.size >= 128) capabilityCache.delete(capabilityCache.keys().next().value!)
  const key = sourceKey(home, source)
  if (capabilityCache.get(key)?.generation === generation)
    capabilityCache.set(key, { at: Date.now(), generation, models: cap })
  return { state: 'supported', source: 'account-models', models }
}
