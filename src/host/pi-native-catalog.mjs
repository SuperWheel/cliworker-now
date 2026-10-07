// Native metadata only. No prompts, API keys, OAuth objects, headers or raw errors leave this boundary.
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export function snapshotNativeCandidates(candidates, env = {}) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => /_(?:API_KEY|TOKEN|SECRET)$/.test(key) && typeof value === 'string' && value)
    .map(([, value]) => value)
  const echoes = (value) =>
    typeof value === 'string' &&
    secrets.some((secret) => value === secret || (secret.length >= 12 && value.includes(secret)))
  return candidates.flatMap((model) => {
    if (
      !model ||
      typeof model !== 'object' ||
      echoes(model.provider) ||
      echoes(model.id) ||
      echoes(model.baseUrl) ||
      echoes(model.api)
    )
      return []
    // Do not persist a native SDK credential/header expansion. Metadata only
    // needs exact routing, effort evidence, and header names to fail closed.
    return [
      {
        provider: model.provider,
        id: model.id,
        name: echoes(model.name) ? model.id : model.name,
        baseUrl: model.baseUrl,
        api: model.api,
        ...(model.headers && typeof model.headers === 'object'
          ? {
              headers: Object.fromEntries(
                Object.keys(model.headers).map((name) => [echoes(name) ? 'authorization' : name, true]),
              ),
            }
          : {}),
        ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
          ? {
              thinkingLevelMap: Object.fromEntries(
                ['off', ...levels]
                  .filter((level) => model.thinkingLevelMap[level] != null)
                  .map((level) => [level, true]),
              ),
            }
          : {}),
        ...(Array.isArray(model.thinking) || Array.isArray(model.thinking?.efforts)
          ? {
              thinking: {
                efforts: (Array.isArray(model.thinking) ? model.thinking : model.thinking.efforts).filter(
                  (level) => ['off', ...levels].includes(level),
                ),
              },
            }
          : {}),
      },
    ]
  })
}
export function projectNativeModel(model, cli) {
  if (
    !model ||
    typeof model.provider !== 'string' ||
    !/^[A-Za-z0-9_.:-]+$/.test(model.provider) ||
    typeof model.id !== 'string' ||
    !model.id ||
    /[\s\x00-\x1f]/.test(model.id)
  )
    throw new Error('Invalid native model identity')
  const efforts =
    cli === 'pi' && model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
      ? levels.filter((level) => model.thinkingLevelMap[level === 'none' ? 'off' : level] != null)
      : cli === 'omp' && (Array.isArray(model.thinking) || Array.isArray(model.thinking?.efforts))
        ? levels.filter((level) =>
            (Array.isArray(model.thinking) ? model.thinking : model.thinking.efforts).includes(
              level === 'none' ? 'off' : level,
            ),
          )
        : []
  return {
    id: `${model.provider}/${model.id}`,
    label: String(model.name ?? model.id),
    efforts: efforts.length ? efforts : ['default'],
  }
}
export async function queryNativeCatalog(...args) {
  try {
    const [cli, executable, directory, env = process.env, onChild = () => {}, options = {}] = args
    return await accountSupportedChoices(
      cli,
      directory,
      await queryNativeCandidates(cli, executable, directory, env, onChild, options),
      env,
      options,
    )
  } catch {
    throw new Error('无法读取 Pi/OMP 原生模型目录，请检查本机配置')
  }
}
export async function queryNativeCandidates(...args) {
  try {
    return await nativeCandidates(...args)
  } catch {
    throw new Error('无法读取 Pi/OMP 原生模型目录，请检查本机配置')
  }
}
// The Host runs this entire phase under its one offline sandbox. Applying a
// second Seatbelt profile inside that process is rejected by macOS (exit 71).
async function nativeCandidates(
  cli,
  executable,
  directory,
  env = process.env,
  onChild = () => {},
  options = {},
) {
  if (cli === 'pi') {
    const dist = dirname(executable)
    const manifest = JSON.parse(await readFile(join(dist, '../package.json'), 'utf8'))
    if (manifest.name !== '@earendil-works/pi-coding-agent' || manifest.version !== '1.0.2')
      throw new Error('Unsupported Pi catalog SDK version')
    const { ModelRuntime } = await import(pathToFileURL(join(dist, 'core/model-runtime.js')).href)
    const { AuthStorage } = await import(pathToFileURL(join(dist, 'core/auth-storage.js')).href)
    const auth = await privateJSON(join(directory, 'auth.json'))
    const usable = Object.fromEntries(
      Object.entries(auth).filter(
        ([, entry]) =>
          entry?.type !== 'oauth' ||
          (typeof entry.expires === 'number' && entry.expires > Date.now() + 30000),
      ),
    )
    const runtime = await ModelRuntime.create({
      credentials: AuthStorage.inMemory(usable),
      modelsPath: join(directory, 'models.json'),
      modelsStorePath: join(directory, 'models-store.json'),
      allowModelNetwork: false,
      signal: options.signal,
    })
    if (runtime.getError()) throw new Error('Invalid native Pi model config')
    return runtime.getAvailableSnapshot()
  }
  const args = ['models', '--json', '--no-extensions', '--config', join(directory, 'config.yml')]
  const js = /\.[cm]?js$/.test(executable)
  const nativeArgs = [js ? process.execPath : executable, ...(js ? [executable, ...args] : args)]
  const child = spawn(nativeArgs[0], nativeArgs.slice(1), {
    cwd: directory,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onChild(child)
  let stdout = '',
    stderr = '',
    size = 0,
    errorSize = 0,
    timedOut = false
  child.stdout.on('data', (chunk) => {
    size += chunk.length
    if (size > 16 * 1024 * 1024) child.kill('SIGTERM')
    else stdout += chunk
  })
  // Native diagnostics can contain endpoint credentials. Drain without forwarding.
  child.stderr.on('data', (chunk) => {
    errorSize += chunk.length
    if (errorSize > 2 * 1024 * 1024) child.kill('SIGTERM')
    else stderr += chunk
  })
  let force
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    force = setTimeout(() => child.kill('SIGKILL'), 5000)
  }, 20000)
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Unable to start native catalog')))
    child.once('close', (code) => resolve(code))
  }).finally(() => {
    clearTimeout(timer)
    clearTimeout(force)
  })
  if (
    timedOut ||
    outcome !== 0 ||
    size > 16 * 1024 * 1024 ||
    errorSize > 2 * 1024 * 1024 ||
    /models\.yml validation failed/i.test(stderr)
  )
    throw new Error('Native OMP catalog query failed')
  const value = JSON.parse(stdout)
  const models = Array.isArray(value) ? value : value.models
  if (!Array.isArray(models)) throw new Error('Invalid native OMP catalog')
  return models
}

// Availability is deliberately separate from native catalog presence. A model
// is selectable only through current account scope or a declared exact API route.
async function privateJSON(path, fallback = {}) {
  const { open } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024)
      throw new Error('Unsafe private metadata input')
    const text = await handle.readFile('utf8')
    const after = await handle.stat()
    const value = JSON.parse(text)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Buffer.byteLength(text) > 2 * 1024 * 1024 ||
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs
    )
      throw new Error('Invalid private metadata input')
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  } finally {
    await handle?.close()
  }
}
const builtinAPI = {
  'zai-coding-cn': { key: 'ZAI_CODING_CN_API_KEY', url: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  'cliworker-zai-cn': { key: 'ZAI_CODING_CN_API_KEY', url: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  'zhipu-coding-plan': { key: 'ZHIPU_API_KEY', url: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  openrouter: { key: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1' },
  groq: { key: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1' },
  openai: { key: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1' },
  anthropic: { key: 'ANTHROPIC_API_KEY', url: 'https://api.anthropic.com/v1', api: 'anthropic-messages' },
  xai: { key: 'XAI_API_KEY', url: 'https://api.x.ai/v1' },
  'xai-oauth': { url: 'https://api.x.ai/v1' },
  'openai-codex': { url: 'https://chatgpt.com/backend-api' },
}
function configuredKey(value, env) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return env[value]
  return value.startsWith('!') ? undefined : value
}
async function privateCredentials(cli, directory) {
  const credentials = new Map()
  if (cli === 'pi') {
    for (const [provider, value] of Object.entries(await privateJSON(join(directory, 'auth.json'))))
      credentials.set(provider, [value])
  } else {
    const { lstat } = await import('node:fs/promises')
    const path = join(directory, 'agent.db')
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error('Unsafe private credential database')
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      for (const row of db
        .prepare('SELECT provider,credential_type,data,disabled_cause FROM auth_credentials')
        .all()) {
        if (row.disabled_cause) continue
        const list = credentials.get(row.provider) ?? []
        list.push({ ...JSON.parse(row.data), type: row.credential_type })
        credentials.set(row.provider, list)
      }
    } finally {
      db.close()
    }
  }
  return credentials
}
export async function accountSupportedChoices(cli, directory, candidates, env = process.env, options = {}) {
  const { probeAccountModels } = await import('./account-models.mjs')
  const custom =
    (await privateJSON(join(directory, cli === 'pi' ? 'models.json' : 'models.yml'))).providers ?? {}
  const credentials = await privateCredentials(cli, directory)
  const groups = new Map()
  for (const model of candidates) {
    const provider = model.provider ?? model.id.slice(0, model.id.indexOf('/'))
    const nativeId = model.provider ? model.id : model.id.slice(model.id.indexOf('/') + 1)
    const config = custom[provider]
    const definition = config?.models?.find((entry) => entry.id === nativeId)
    const defaults = builtinAPI[provider] ?? {}
    const authHeaders =
      /authorization|auth[-_]|api[-_]?key|token|cookie|organization|organisation|project|account[-_]?id|tenant|workspace[-_]?id/i
    // Native configured headers can replace the execution credential/scope.
    // Until the metadata probe mirrors that exact identity, do not query another
    // credential or publish a misleading availability/cost result for this model.
    if (
      [model.headers, definition?.headers, config?.headers].some(
        (headers) =>
          headers &&
          typeof headers === 'object' &&
          Object.keys(headers).some((name) => authHeaders.test(name)),
      )
    )
      continue
    // Effective SDK model routing wins; OMP's summary omits this information,
    // so use the explicit model/provider configuration before pinned native defaults.
    const baseUrl = model.baseUrl ?? definition?.baseUrl ?? config?.baseUrl ?? defaults.url
    const apiType = model.api ?? definition?.api ?? config?.api ?? defaults.api
    if (typeof baseUrl !== 'string') continue
    const key = JSON.stringify([provider, baseUrl, apiType])
    const group = groups.get(key) ?? { provider, baseUrl, apiType, models: [] }
    group.models.push(model)
    groups.set(key, group)
  }
  const results = await Promise.all(
    [...groups.values()].map(async ({ provider, baseUrl, apiType, models }) => {
      const config = custom[provider]
      const defaults = builtinAPI[provider] ?? {}
      const stored = credentials.get(provider) ?? []
      const groupIds = new Set(
        models.map((model) => (model.provider ? model.id : model.id.slice(model.id.indexOf('/') + 1))),
      )
      const customIds = Array.isArray(config?.models)
        ? config.models.map((model) => model.id).filter((id) => groupIds.has(id))
        : []
      // No historic credential fingerprint is bound to this snapshot. A provider
      // name or Host reference alone cannot transfer old successful-model proof.
      const verifiedIds = []
      if (typeof config?.apiKey === 'string' && config.apiKey.trimStart().startsWith('!')) return []
      const explicitKey = configuredKey(config?.apiKey, env)
      if (cli === 'omp' && config?.apiKey !== undefined && !explicitKey) return []
      const defaultKey = defaults.key ? env[defaults.key] : undefined
      const oauthEntries = stored.filter((entry) => entry.type === 'oauth')
      const loginEntries = stored.filter(
        (entry) => ['api', 'api_key'].includes(entry.type) && entry.source === 'login',
      )
      // Pi1.0.2 resolves stored auth before models.json/env. OMP16.4.4 has
      // config override -> OAuth -> login API -> default env -> stored static API.
      const entries =
        cli === 'pi'
          ? stored.length
            ? stored
            : explicitKey || defaultKey
              ? [{ type: 'api', key: explicitKey ?? defaultKey }]
              : []
          : explicitKey
            ? [{ type: 'api', key: explicitKey }]
            : oauthEntries.length
              ? oauthEntries
              : loginEntries.length
                ? loginEntries
                : defaultKey
                  ? [{ type: 'api', key: defaultKey }]
                  : stored
      const secrets = [
        ...stored.map((entry) => entry.access ?? entry.key ?? entry.apiKey),
        explicitKey,
        defaultKey,
      ].filter((value) => typeof value === 'string' && value)
      const echoes = (value) =>
        typeof value === 'string' &&
        secrets.some((secret) => value === secret || (secret.length >= 12 && value.includes(secret)))
      const scopes = await Promise.all(
        entries.map(async (credential) => {
          const type =
            credential.type === 'oauth'
              ? 'oauth'
              : ['api', 'api_key'].includes(credential.type)
                ? 'api'
                : undefined
          if (!type) return { state: 'unknown', models: [] }
          return probeAccountModels(
            {
              provider,
              baseUrl,
              apiType,
              customModelIds: customIds,
              verifiedModelIds: verifiedIds,
              credential:
                type === 'oauth'
                  ? {
                      type,
                      access: credential.access,
                      expires: credential.expires,
                      accountId: credential.accountId,
                    }
                  : { type, key: credential.key ?? credential.apiKey },
            },
            options,
          )
        }),
      )
      // Native pools may choose any active login. A union/any-free projection can
      // promise an unsupported or paid execution, so use the conservative intersection.
      const supported = new Map()
      if (scopes.length && scopes.every((scope) => scope.state === 'supported'))
        for (const model of scopes[0].models) {
          const variants = scopes.map((scope) => scope.models.find((entry) => entry.id === model.id))
          if (variants.some((entry) => !entry)) continue
          const cost = variants.every((entry) => entry.cost === 'free')
            ? 'free'
            : variants.some((entry) => entry.cost === 'unknown')
              ? 'unknown'
              : 'paid'
          supported.set(model.id, { ...model, cost })
        }
      return models.flatMap((model) => {
        const choice = model.provider ? projectNativeModel(model, cli) : model
        const id = choice.id.slice(choice.id.indexOf('/') + 1)
        const scope = supported.get(id)
        if (!scope || echoes(id) || echoes(choice.id)) return []
        const label = scope.name ?? (typeof model.name === 'string' ? model.name : choice.label)
        return [
          {
            ...choice,
            label: echoes(label) ? id : label,
            cost: scope.cost,
          },
        ]
      })
    }),
  )
  return results.flat()
}
