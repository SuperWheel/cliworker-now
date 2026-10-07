import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { probeAccountModels, type AccountModelInput, type AccountModelScope } from './account-models.mjs'

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const literal = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  !/[\x00-\x1f]/.test(value) &&
  !/^(?:op:\/\/|!|\$|<|your[_ -]|placeholder|changeme)/i.test(value.trim())
const unknown = (): AccountModelScope => ({ state: 'unknown', source: 'unknown', models: [] })

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
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const value = match[2]!
      .replace(/\s+#.*$/, '')
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim()
    if (value) result[match[1]!] = value
  }
  return result
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
    const config = parse((await read(join(home, 'config.yaml'), options.signal)) ?? '')
    if (!object(config) || !object(config.model) || config.model.provider !== provider) return unknown()
    if (config.providers?.[provider]?.enabled === false) return unknown()
    const cfg = config.model
    const env = dotenv((await read(join(home, '.env'), options.signal)) ?? '')
    const auth = JSON.parse((await read(join(home, 'auth.json'), options.signal)) ?? '{}')
    if (!object(auth)) return unknown()
    // Extra headers, command secrets, endpoint overrides and unknown pool routes
    // cannot be reconstructed faithfully from a public model catalog.
    if (cfg.extra_headers && Object.keys(cfg.extra_headers).length) return unknown()
    const inputs: AccountModelInput[] = []
    if (provider === 'openai-codex') {
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
      // Pooled/borrowed identities can be selected by native runtime; don't use a
      // singleton's permissions to authorize an unknown pool or external account.
      if (auth.credential_pool?.[provider]?.length) return unknown()
      const state = auth.providers?.[provider],
        tokens = state?.tokens
      if (state?.auth_mode !== 'chatgpt' || !literal(tokens?.access_token)) return unknown()
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
            entry.disabled === true ||
            entry.status === 'exhausted' ||
            (entry.base_url && entry.base_url.replace(/\/+$/, '') !== canonical)
          )
            return unknown()
          if (typeof entry.source === 'string' && entry.source.startsWith('env:')) {
            const name = entry.source.slice(4)
            if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !literal(env[name])) return unknown()
            envNames.add(name)
            continue
          }
          if (entry.source && !['manual', 'config'].includes(entry.source)) return unknown()
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
  } catch {
    options.signal?.throwIfAborted()
    return unknown()
  }
}
