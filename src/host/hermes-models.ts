import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { parseHermesOwnEnvironment } from './hermes-env.ts'
import { hermesUnsuppressedEnvironment, projectHermesUnsuppressedAuth } from './hermes-suppression.ts'
import {
  beginHermesNousCapabilities,
  fetchHermesNousModels,
  forgetHermesNousCapabilities,
  HermesNousError,
  selectHermesNousSource,
} from './hermes-nous.ts'
import { probeAccountModels, type AccountModelInput, type AccountModelScope } from './account-models.mjs'

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const literal = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  !/[\x00-\x1f]/.test(value) &&
  !/^(?:op:\/\/|!|\$|<|your[_ -]|placeholder|changeme)/i.test(value.trim())
const unknown = (): AccountModelScope => ({ state: 'unknown', source: 'unknown', models: [] })

/** Native PooledCredential fields; a successful catalog cannot erase a native
 * dead account, active exhaustion window or model-specific entitlement bench. */
export function hermesPoolEntryUnavailable(entry: Record<string, any>, model?: string): boolean {
  if (entry.disabled === true || entry.status === 'exhausted' || entry.last_status === 'dead') return true
  if (entry.last_status === 'exhausted') {
    const until = Number(entry.last_error_reset_at)
    if (!Number.isFinite(until) || until <= 0 || until > Date.now() / 1000) return true
  }
  const cooldowns = object(entry.model_cooldowns) ? entry.model_cooldowns : {}
  const values = model ? [cooldowns[model]] : Object.values(cooldowns)
  return values.some((until) => typeof until === 'number' && until > Date.now() / 1000)
}

/** Private source reads only. Do not execute secret commands, expand arbitrary env,
 * refresh OAuth, print native config, or import Hermes' side-effectful runtime. */
async function read(path: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted()
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('Unsafe metadata')
    const buffer = Buffer.alloc(info.size + 1)
    try {
      let length = 0
      while (length < buffer.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > info.size) throw new Error('Metadata changed')
      return buffer.subarray(0, length).toString('utf8')
    } finally {
      buffer.fill(0)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    signal?.throwIfAborted()
    throw new Error('Hermes 账号配置无法安全读取，请在原生登录设置中检查')
  } finally {
    await handle?.close()
  }
}

function dotenv(text: string): Record<string, string> {
  return parseHermesOwnEnvironment(text)
}

/** Internal source material; callers must never publish or log the returned values. */
export async function readHermesAccountMaterial(home: string, signal?: AbortSignal) {
  const config = parse((await read(join(home, 'config.yaml'), signal)) ?? '')
  const auth = JSON.parse((await read(join(home, 'auth.json'), signal)) ?? '{}')
  const env = dotenv((await read(join(home, '.env'), signal)) ?? '')
  if (!object(config) || !object(auth)) throw new Error('Hermes 账号配置无效')
  return { config, auth, env, sourceIds: [home] }
}

/** Exact native source/provider pairs from auth_commands and credential_pool.
 * In particular manual:qwen_cli is still a foreign login, not a Hermes OAuth flow. */
function ownPoolSource(
  provider: string,
  entry: Record<string, any>,
  material: Awaited<ReturnType<typeof readHermesAccountMaterial>>,
): boolean {
  const source = entry.source
  if ((!source || source === 'manual' || source === 'config') && entry.auth_type === 'api_key') return true
  if (typeof source !== 'string') return false
  if (source.startsWith('env:')) return literal(material.env[source.slice(4)])
  const ownOAuth: Record<string, string[]> = {
    anthropic: ['manual:hermes_pkce', 'hermes_pkce'],
    'openai-codex': ['manual:device_code', 'manual:loopback_pkce', 'device_code'],
    'xai-oauth': ['manual:device_code', 'device_code'],
    'minimax-oauth': ['manual:minimax_oauth', 'oauth'],
    nous: ['manual:device_code', 'device_code'],
  }
  if (entry.auth_type === 'oauth' && ownOAuth[provider]?.includes(source)) return true
  return provider === 'openrouter' && entry.auth_type === 'api_key' && source === 'manual:openrouter_pkce'
}

/** Native own stores only; never accept a broad manual:* prefix. */
export async function assertHermesOwnAccounts(home: string, signal?: AbortSignal) {
  const material = await readHermesAccountMaterial(home, signal)
  try {
    await lstat(join(home, '.cliworker-managed'))
    throw new Error('Hermes 插件账号不能使用额外的托管配置')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await lstat(join(home, '.op.env'))
    throw new Error('Hermes 请使用自身 .env，暂不支持外部密码库配置')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (Object.values(material.env).some((value) => /^(?:op:\/\/|!|\$\{|__BITWARDEN_MANAGED__)/.test(value)))
    throw new Error('Hermes 请使用自身 API 配置，暂不支持外部密码库引用')
  if (material.config.auth?.adopt_external_logins !== false)
    throw new Error('请先关闭 Hermes 的 auth.adopt_external_logins')
  if (
    material.config.model?.openai_runtime === 'codex_app_server' ||
    material.config.model?.api_mode === 'codex_app_server'
  )
    throw new Error('Hermes 当前使用外部 Codex 登录，请改用自身账号')
  // Native dotenv has override=True. Selector assignments would invalidate the
  // account source selected by the Host, even when no API-key value is inherited.
  for (const [provider, entries] of Object.entries(material.auth.credential_pool ?? {})) {
    if (!Array.isArray(entries)) throw new Error('Hermes 账号来源无法确认')
    for (const entry of entries) {
      if (!object(entry)) throw new Error('Hermes 账号来源无法确认')
      if (!ownPoolSource(provider, entry, material)) throw new Error('Hermes 含外部账号来源，请使用自身登录')
    }
  }
  return material
}

/** Current selected-provider account scope. Unknown provider/auth schemas fail closed.
 * Route precedence follows Hermes runtime_provider_backends / credential_pool;
 * only the canonical OpenRouter route and native Codex OAuth store are supported
 * without an explicit endpoint. Ambiguous mirrors/custom pools are not guessed. */
export async function hermesAccountModels(
  home: string,
  provider: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<AccountModelScope> {
  try {
    const currentMaterial = async () => {
      const raw = await assertHermesOwnAccounts(home, options.signal)
      return {
        ...raw,
        auth: projectHermesUnsuppressedAuth(raw.auth),
        env: hermesUnsuppressedEnvironment(raw.auth, raw.env, provider),
      }
    }
    const material = await currentMaterial()
    const { config, auth, env } = material
    if (!object(config) || !object(config.model) || config.model.provider !== provider) return unknown()
    if (config.providers?.[provider]?.enabled === false) return unknown()
    const cfg = config.model
    if (!object(auth)) return unknown()
    // Extra headers, command secrets, endpoint overrides and unknown pool routes
    // cannot be reconstructed faithfully from a public model catalog.
    if (cfg.extra_headers && Object.keys(cfg.extra_headers).length) return unknown()
    const inputs: AccountModelInput[] = []
    if (provider === 'nous') {
      const source = selectHermesNousSource(material)
      const generation = beginHermesNousCapabilities(home, source)
      try {
        const result = await fetchHermesNousModels(home, source, options, generation)
        options.signal?.throwIfAborted()
        const current = selectHermesNousSource(await currentMaterial())
        // A query never authorizes a credential that appeared while it was in flight.
        // Stable task bindings intentionally ignore ordinary token rotation separately.
        if (
          current.agentKey !== source.agentKey ||
          JSON.stringify(current.principal) !== JSON.stringify(source.principal) ||
          JSON.stringify(current.route) !== JSON.stringify(source.route) ||
          JSON.stringify(current.modelCooldowns) !== JSON.stringify(source.modelCooldowns)
        )
          throw new HermesNousError('Nous 账号已变化，请重新刷新模型')
        return result
      } catch (error) {
        forgetHermesNousCapabilities(home, source, generation)
        throw error
      }
    } else if (provider === 'openai-codex') {
      // This transport authenticates via a separate Codex app-server session;
      // Hermes' OAuth store cannot prove that other account's model scope.
      if (cfg.openai_runtime === 'codex_app_server' || cfg.api_mode === 'codex_app_server') return unknown()
      if (
        env.HERMES_CODEX_BASE_URL &&
        env.HERMES_CODEX_BASE_URL.replace(/\/+$/, '') !== 'https://chatgpt.com/backend-api'
      )
        return unknown()
      if (cfg.base_url && cfg.base_url.replace(/\/+$/, '') !== 'https://chatgpt.com/backend-api')
        return unknown()
      const state = auth.providers?.[provider],
        tokens = state?.tokens
      if (state?.auth_mode !== 'chatgpt' || !literal(tokens?.access_token)) return unknown()
      // Native load_pool seeds this exact singleton as device_code. Additional
      // accounts require their own proven scope, so do not authorize them via it.
      const pool = auth.credential_pool?.[provider] ?? []
      if (
        !Array.isArray(pool) ||
        pool.some(
          (entry: any) =>
            !object(entry) ||
            entry.source !== 'device_code' ||
            entry.auth_type !== 'oauth' ||
            hermesPoolEntryUnavailable(entry, cfg.default) ||
            entry.access_token !== tokens.access_token ||
            (entry.base_url && entry.base_url.replace(/\/+$/, '') !== 'https://chatgpt.com/backend-api'),
        )
      )
        return unknown()
      let expiry = typeof tokens.expires_at === 'number' ? tokens.expires_at : Date.parse(tokens.expires_at)
      if (!Number.isFinite(expiry)) {
        // Hermes' native Codex store uses the access JWT exp claim.
        try {
          expiry = JSON.parse(
            Buffer.from(tokens.access_token.split('.')[1] ?? '', 'base64url').toString(),
          ).exp
        } catch {
          return unknown()
        }
      }
      inputs.push({
        provider,
        credential: {
          type: 'oauth',
          access: tokens.access_token,
          expires: expiry < 1e12 ? expiry * 1000 : expiry,
          accountId: tokens.account_id,
        },
      })
    } else if (provider === 'openrouter') {
      const canonical = 'https://openrouter.ai/api/v1'
      if (
        [cfg.base_url, env.OPENROUTER_BASE_URL, env.CUSTOM_BASE_URL].some(
          (url) => url && (typeof url !== 'string' || url.replace(/\/+$/, '') !== canonical),
        ) ||
        env.OPENAI_BASE_URL
      )
        return unknown()
      const pool = auth.credential_pool?.openrouter
      const keys = new Set<string>()
      const envNames = new Set(['OPENROUTER_API_KEY'])
      for (const name of Object.keys(env)) if (/^OPENROUTER_API_KEY_\d+$/.test(name)) envNames.add(name)
      if (Array.isArray(pool) && pool.length) {
        if (pool.length > 8) return unknown()
        // Native pool selection may rotate. Every potential credential must support
        // the choice. Do not expose exhausted/expired/unknown entries via another key.
        for (const entry of pool) {
          if (
            !object(entry) ||
            entry.auth_type !== 'api_key' ||
            hermesPoolEntryUnavailable(entry, cfg.default) ||
            (entry.base_url && entry.base_url.replace(/\/+$/, '') !== canonical)
          )
            return unknown()
          if (typeof entry.source === 'string' && entry.source.startsWith('env:')) {
            const name = entry.source.slice(4)
            if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !literal(env[name])) return unknown()
            envNames.add(name)
            continue
          }
          if (!ownPoolSource(provider, entry, { config, auth, env, sourceIds: [home] })) return unknown()
          const key = entry.runtime_api_key || entry.access_token
          if (!literal(key)) return unknown()
          keys.add(key)
        }
      }
      // Native pool loader seeds numbered environment keys and rehydrates env:
      // rows on each load. A saved token cannot override its current env source.
      for (const name of envNames)
        if (env[name]) {
          if (!literal(env[name]) || env[name].includes('${')) return unknown()
          keys.add(env[name])
        }
      if (!keys.size || keys.size > 8) return unknown()
      for (const key of keys) inputs.push({ provider, baseUrl: canonical, credential: { type: 'api', key } })
    } else {
      // Do not fabricate endpoint/key mappings for arbitrary provider plugins.
      return unknown()
    }
    const scopes: AccountModelScope[] = []
    const deadline = AbortSignal.timeout(15000)
    const probeOptions = {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    }
    for (const input of inputs) {
      options.signal?.throwIfAborted()
      const scope = await probeAccountModels(input, probeOptions)
      options.signal?.throwIfAborted()
      if (scope.state !== 'supported') return scope
      scopes.push(scope)
    }
    if (!scopes.length) return unknown()
    return {
      state: 'supported',
      source: 'account-models',
      models: scopes[0]!.models.flatMap((model) => {
        const matches = scopes.map((scope) => scope.models.find((candidate) => candidate.id === model.id))
        // Native setup selected this model; public/account catalogs may also contain
        // embeddings or other endpoints that Hermes chat cannot execute.
        if (model.id !== cfg.default || matches.some((match) => !match)) return []
        const cost = matches.every((match) => match!.cost === 'free')
          ? 'free'
          : matches.every((match) => match!.cost === 'paid')
            ? 'paid'
            : 'unknown'
        return [{ ...model, cost }]
      }),
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof HermesNousError) throw error
    return unknown()
  }
}
