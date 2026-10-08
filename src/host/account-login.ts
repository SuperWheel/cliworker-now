import type { AccountLogin } from '../shared/accounts.ts'
import type { AccountIdentity } from './account-identity.ts'

const providerNames: Record<string, string> = {
  openai: 'OpenAI',
  'openai-codex': 'OpenAI',
  'openai-codex-responses': 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'google-gemini-cli': 'Google',
  'google-antigravity': 'Google',
  'github-copilot': 'GitHub Copilot',
  xai: 'xAI',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  deepseek: 'DeepSeek',
  zai: 'Z.AI',
  'zai-coding-plan': 'Z.AI',
  zhipu: '智谱',
  zhipuai: '智谱',
  'zai-coding-cn': 'zai.cn',
  'zhipu-coding-plan': 'zai.cn',
  'zhipuai-coding-plan': 'zai.cn',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax',
  'minimax-coding-plan': 'MiniMax',
  'minimax-cn-coding-plan': 'MiniMax',
  kimi: 'Kimi',
  'kimi-code': 'Kimi',
  'kimi-coding': 'Kimi',
  moonshot: 'Moonshot',
  nous: 'Nous',
  'nous-research': 'Nous',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
  qwen: 'Qwen',
  'qwen-portal': 'Qwen',
}
const credentialShape = /\b(?:Bearer|sk[-_]|gh[pousr]_|ya29\.|eyJ)|(?:api[-_ ]?key|secret|token)/iu
function safeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  if (
    !name ||
    name.length > 48 ||
    credentialShape.test(name) ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name) ||
    /[A-Za-z0-9_]{25,}/u.test(name)
  )
    return undefined
  return name
}
function endpoint(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url : undefined
  } catch {
    return undefined
  }
}
function endpointName(url: URL | undefined): string | undefined {
  if (!url) return undefined
  const names: Record<string, string> = {
    'api.openai.com': 'OpenAI',
    'api.anthropic.com': 'Anthropic',
    'generativelanguage.googleapis.com': 'Google',
    'api.x.ai': 'xAI',
    'api.z.ai': 'Z.AI',
    'openrouter.ai': 'OpenRouter',
    'api.deepseek.com': 'DeepSeek',
    'api.minimax.io': 'MiniMax',
    'api.minimaxi.com': 'MiniMax',
    'api.moonshot.ai': 'Moonshot',
    'api.moonshot.cn': 'Moonshot',
  }
  if (url.protocol === 'https:' && !url.port && !url.username && !url.password) {
    if (url.hostname === 'open.bigmodel.cn')
      return url.pathname.startsWith('/api/coding/') ? 'zai.cn' : '智谱'
    if (Object.hasOwn(names, url.hostname)) return names[url.hostname]
  }
  // Only the host is displayable: never userinfo, port, path, query or fragment.
  return safeName(url.hostname)
}

/** Display metadata only; the caller must establish current own credential evidence. */
export function providerLogin(
  provider: string,
  authMethod: AccountLogin['authMethod'],
  details: { baseUrl?: unknown; name?: unknown } = {},
): AccountLogin {
  const url = endpoint(details.baseUrl)
  const known = Object.hasOwn(providerNames, provider) ? providerNames[provider] : undefined
  const providerLabel =
    (authMethod === 'api'
      ? endpointName(url) || known || safeName(details.name) || safeName(provider)
      : known || safeName(details.name) || safeName(provider) || endpointName(url)) || '自定义服务商'
  return { providerLabel, authMethod }
}

/** Explicit native API values, excluding placeholders and unevaluated references. */
export function usableNativeApiKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  const key = value.trim()
  return (
    !/[\s\p{C}<>]/u.test(key) &&
    !key.startsWith('!') &&
    !/\$\{|\{(?:env|file):|^\$[A-Z_]|^(?:your(?:[-_].*)?|replace[-_]?me|change[-_]?me|placeholder|example[-_]?key|sk[-_](?:x{3,}|\.\.\.))$/iu.test(
      key,
    )
  )
}

export function authenticatedAccountLogins(input: AccountLogin[]): AccountIdentity {
  const seen = new Set<string>()
  const logins = input.filter((login) => {
    const key = JSON.stringify([login.providerLabel, login.authMethod, login.accountLabel])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!logins.length) throw new Error('Missing native account login evidence')
  const methods = new Set(logins.map((login) => login.authMethod))
  const authMethod = methods.size === 1 ? logins[0]!.authMethod : undefined
  return {
    state: 'authenticated',
    verification: 'local',
    logins,
    ...(authMethod ? { authMethod } : {}),
    summary: authMethod === 'api' ? 'API 登录' : '已登录',
  }
}
