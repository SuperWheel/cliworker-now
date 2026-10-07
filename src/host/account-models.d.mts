export interface AccountModelScope {
  state: 'supported' | 'denied' | 'unknown'
  source: 'account-models' | 'configured-custom' | 'verified-route' | 'unknown'
  models: { id: string; name?: string; cost: 'free' | 'paid' | 'unknown' }[]
}
export interface AccountModelInput {
  provider: string
  credential: { type: 'api' | 'oauth'; key?: string; access?: string; expires?: number; accountId?: string }
  baseUrl?: string
  apiType?: string
  /** Mirror a native route that explicitly sends both Anthropic auth headers. */
  anthropicAuth?: 'api-key-and-bearer'
  customModelIds?: string[]
  verifiedModelIds?: string[]
}
export function probeAccountModels(
  input: AccountModelInput,
  options?: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number },
): Promise<AccountModelScope>
