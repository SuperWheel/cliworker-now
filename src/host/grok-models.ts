import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { accountEmail, localTokenExpired } from './account-identity.ts'
import { EFFORTS, type Effort, type ModelChoice } from '../shared/types.ts'

export const GROK_MODELS_URL = 'https://cli-chat-proxy.grok.com/v1/models'
export const GROK_SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string =>
  typeof v === 'string' && !!v && v.length <= 32768 && !/[\x00-\x20\x7f]/.test(v)
export class GrokModelsError extends Error {}
/** This adapter supports the fixed first-party route, not ambient provider overrides. */
export function assertGrokNativeEnvironment(home = homedir()): void {
  if (process.env.GROK_HOME?.trim() && resolve(process.env.GROK_HOME) !== resolve(home, '.grok'))
    throw new GrokModelsError('当前 Grok 认证配置不受支持')
  if (
    [
      'GROK_AUTH_PROVIDER_COMMAND',
      'GROK_OIDC_ISSUER',
      'GROK_OIDC_CLIENT_ID',
      'GROK_CLI_CHAT_PROXY_BASE_URL',
      'GROK_MODELS_BASE_URL',
      'GROK_MODELS_LIST_URL',
      'GROK_XAI_API_BASE_URL',
      'GROK_DEPLOYMENT_KEY',
      'GROK_AUTH_PATH',
      'GROK_CONFIG_PATH',
    ].some((key) => process.env[key]?.trim())
  )
    throw new GrokModelsError('当前 Grok 认证配置不受支持')
}
export interface GrokOwnAccount {
  access: string
  refresh: boolean
  expires: number
  active: boolean
  userId: string
  clientId: string
  email?: string
}
/** Official native OIDC slot and its own identity, not arbitrary configured keys. */
export function selectGrokOwnAccount(raw: unknown, now = Date.now()): GrokOwnAccount | undefined {
  if (!object(raw)) return undefined
  const entries = Object.entries(raw).filter(
    ([slot, value]) => slot.startsWith('https://auth.x.ai::') && object(value) && value.auth_mode === 'oidc',
  )
  if (entries.length !== 1) return undefined
  const [slot, value] = entries[0]!
  if (
    !object(value) ||
    value.oidc_issuer !== 'https://auth.x.ai' ||
    !text(value.oidc_client_id) ||
    slot !== `https://auth.x.ai::${value.oidc_client_id}` ||
    !text(value.user_id)
  )
    return undefined
  if (!text(value.key)) return undefined
  const access = value.key
  const created = typeof value.create_time === 'string' ? Date.parse(value.create_time) : NaN
  const expires =
    typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : created + 30 * 86400_000
  return {
    access,
    expires,
    refresh: text(value.refresh_token),
    userId: value.user_id,
    clientId: value.oidc_client_id,
    active: !!access && Number.isFinite(expires) && expires > now && !localTokenExpired(access, now),
    ...(accountEmail(value.email) ? { email: accountEmail(value.email) } : {}),
  }
}
export async function readGrokOwnAccount(options: { home?: string; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted()
  assertGrokNativeEnvironment(options.home)
  const buffer = Buffer.alloc(65537)
  let file
  try {
    const root = join(await realpath(options.home ?? homedir()), '.grok')
    const directory = await lstat(root)
    if (!directory.isDirectory() || directory.isSymbolicLink() || (await realpath(root)) !== root)
      throw new Error()
    const path = join(root, 'auth.json')
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error()
    let size = 0
    while (size < buffer.length) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    if (!size || size > 65536) throw new Error()
    const bytes = buffer.subarray(0, size)
    const account = selectGrokOwnAccount(JSON.parse(bytes.toString('utf8')))
    if (!account || (!account.active && !account.refresh)) throw new Error()
    options.signal?.throwIfAborted()
    const currentDirectory = await lstat(root)
    if (
      currentDirectory.isSymbolicLink() ||
      currentDirectory.dev !== directory.dev ||
      currentDirectory.ino !== directory.ino
    )
      throw new Error()
    return { ...account, fingerprint: createHash('sha256').update(bytes).digest('hex') }
  } catch {
    options.signal?.throwIfAborted()
    throw new GrokModelsError('请先登录 Grok')
  } finally {
    buffer.fill(0)
    await file?.close()
  }
}

/** Only metadata IDs pass out; a successful empty list differs from a failed query. */
export function grokAccountModels(
  payload: unknown,
  forbidden: string[] = [],
): Map<string, Effort[] | undefined> {
  if (!object(payload) || !Array.isArray(payload.data)) throw new GrokModelsError('模型目录格式无效')
  const result = new Map<string, Effort[] | undefined>()
  for (const value of payload.data) {
    if (!object(value)) throw new GrokModelsError('模型目录格式无效')
    const meta = object(value._meta) ? value._meta : {}
    // supported_in_api=false denotes a session-only model; this is a session request.
    if (
      value.hidden === true ||
      meta.hidden === true ||
      value.allowed === false ||
      value.available === false ||
      value.entitled === false ||
      value.enabled === false ||
      value.disabled === true ||
      value.upgrade_required === true
    )
      continue
    const id = value.model ?? value.modelId ?? value.id ?? meta.model ?? meta.modelId
    if (
      typeof id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id) ||
      forbidden.some((secret) => secret && id.includes(secret))
    )
      throw new GrokModelsError('模型目录格式无效')
    if (result.has(id)) throw new GrokModelsError('模型目录格式无效')
    const supports =
      value.supportsReasoningEffort ?? value.supports_reasoning_effort ?? meta.supportsReasoningEffort
    const rawEfforts = value.reasoningEfforts ?? value.reasoning_efforts ?? meta.reasoningEfforts
    let efforts: Effort[] | undefined
    if (supports === false) efforts = ['default']
    else if (rawEfforts !== undefined) {
      if (!Array.isArray(rawEfforts)) throw new GrokModelsError('模型目录格式无效')
      efforts = [
        ...new Set(
          rawEfforts.flatMap((item) => {
            const id = object(item) ? item.id : item
            return typeof id === 'string' && EFFORTS.includes(id as Effort) ? [id as Effort] : []
          }),
        ),
      ]
    }
    result.set(id, efforts)
  }
  return result
}
export function grokAccountModelIds(payload: unknown, forbidden: string[] = []): Set<string> {
  return new Set(grokAccountModels(payload, forbidden).keys())
}
/** Installed grok 1.0.0 (3cd0d0cbcebe) consumes these dynamic /models fields.
 * Verified against its actual ACP response using an isolated loopback fixture;
 * the built-in grok-4.5 fallback is not a limit on dynamic model IDs or xhigh.
 */
export function grokDynamicNativeModels(payload: unknown, forbidden: string[] = []): ModelChoice[] {
  const scoped = grokAccountModels(payload, forbidden)
  if (!object(payload) || !Array.isArray(payload.data)) return []
  return payload.data.flatMap((value) => {
    if (!object(value)) return []
    const meta = object(value._meta) ? value._meta : {}
    const id = value.model ?? value.modelId ?? value.id ?? meta.model ?? meta.modelId
    if (typeof id !== 'string' || !scoped.has(id)) return []
    // Never import a remote BYOK route or credential into this session adapter.
    for (const key of ['baseUrl', 'base_url', 'apiBaseUrl', 'api_base_url']) {
      const route = value[key]
      if (route !== undefined && route !== 'https://cli-chat-proxy.grok.com/v1')
        throw new GrokModelsError('模型目录地址不受支持')
    }
    if (
      ['api_key', 'apiKey', 'env_key', 'envKey', 'auth_provider', 'authProvider'].some(
        (key) => value[key] !== undefined,
      )
    )
      throw new GrokModelsError('模型认证配置不受支持')
    const supports =
      value.supportsReasoningEffort ?? value.supports_reasoning_effort ?? meta.supportsReasoningEffort
    const efforts =
      supports === false
        ? ['default' as const]
        : supports === true
          ? scoped.get(id)?.filter((effort) => ['low', 'medium', 'high', 'xhigh'].includes(effort))
          : []
    if (!efforts?.length) return []
    const label =
      typeof value.name === 'string' &&
      value.name.length <= 256 &&
      !/\p{C}/u.test(value.name) &&
      !forbidden.some((secret) => secret && value.name!.toString().includes(secret))
        ? value.name
        : id
    return [{ id, label, efforts }]
  })
}
async function readPayload(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new GrokModelsError('模型目录格式无效')
  let length = 0
  const chunks: Uint8Array[] = []
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 2097152) throw new GrokModelsError('模型目录过大')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
/** Fixed official Build endpoint; no redirect, OAuth refresh, fallback, or generation. */
export async function discoverGrokAccountModels(
  native: ModelChoice[],
  options: {
    home?: string
    signal?: AbortSignal
    fetch?: typeof fetch
    timeoutMs?: number
    nativeDynamicSchema?: boolean
  } = {},
): Promise<ModelChoice[]> {
  options.signal?.throwIfAborted()
  const source = await readGrokOwnAccount(options)
  if (!source.active || source.expires <= Date.now() + 30000)
    throw new GrokModelsError('登录需要续期，请打开 Grok')
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), Math.max(50, Math.min(options.timeoutMs ?? 8000, 10000)))
  try {
    // Native 1.0.0-era remote/client.rs:715-787, xai-grok-http/src/lib.rs:247-261.
    const request = async (target: string) => {
      const response = await (options.fetch ?? fetch)(target, {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          accept: 'application/json',
          Authorization: `Bearer ${source.access}`,
          'X-XAI-Token-Auth': 'xai-grok-cli',
          'x-userid': source.userId,
          'x-grok-client-version': '1.0.0',
          'x-grok-client-mode': 'headless',
          ...(source.email ? { 'x-email': source.email } : {}),
        },
      })
      if (response.redirected || (response.url && response.url !== target)) {
        await response.body?.cancel()
        throw new GrokModelsError('模型目录地址不受支持')
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new GrokModelsError(
          response.status === 401
            ? '登录已失效，请重新登录'
            : response.status === 403
              ? '模型目录访问被拒绝'
              : '模型目录查询失败，请刷新',
        )
      }
      return readPayload(response, signal)
    }
    const unchanged = async () => {
      signal.throwIfAborted()
      const current = await readGrokOwnAccount(options)
      if (source.fingerprint !== current.fingerprint) throw new GrokModelsError('账号已改变，请刷新')
      signal.throwIfAborted()
    }
    // The Build access gate permits free allowlisted accounts too. A model list
    // or a paid-tier claim alone is not the native access decision.
    const settings = await request(GROK_SETTINGS_URL)
    await unchanged()
    if (!object(settings) || typeof settings.allow_access !== 'boolean')
      throw new GrokModelsError('模型使用权限尚未确认')
    if (!settings.allow_access) throw new GrokModelsError('当前账号未获 Grok Build 使用权限')
    const payload = await request(GROK_MODELS_URL)
    const models = grokAccountModels(payload, [source.access, source.userId])
    signal.throwIfAborted()
    await unchanged()
    signal.throwIfAborted()
    if (!models.size) throw new GrokModelsError('账号目录未返回模型')
    const capabilities = options.nativeDynamicSchema
      ? grokDynamicNativeModels(payload, [source.access, source.userId])
      : native
    const result = capabilities.flatMap((model) => {
      if (!models.has(model.id)) return []
      const allowed = models.get(model.id)
      const efforts = allowed
        ? (model.efforts ?? []).filter((effort) => allowed.includes(effort))
        : (model.efforts ?? [])
      return efforts.length ? [{ ...model, efforts }] : []
    })
    if (!result.length) throw new GrokModelsError('当前 CLI 未支持账号模型')
    return result
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof GrokModelsError) throw error
    throw new GrokModelsError(controller.signal.aborted ? '模型目录查询超时' : '模型目录查询失败，请刷新')
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
