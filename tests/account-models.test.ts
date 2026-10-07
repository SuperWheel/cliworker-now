import { describe, expect, it, vi } from 'vitest'
import { probeAccountModels } from '../src/host/account-models.mjs'
const key = 'SYNTHETIC_PRIVATE_KEY_NEVER_DISPLAYED'
const api = (extra = {}) => ({
  provider: 'custom',
  baseUrl: 'https://metadata.test/v1',
  credential: { type: 'api' as const, key },
  ...extra,
})
const oauth = () => ({
  provider: 'openai-codex',
  credential: { type: 'oauth' as const, access: key, expires: Date.now() + 3600000 },
})
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('read-only account-supported metadata (all credentials and responses simulated)', () => {
  it('keeps ordinary Anthropic metadata authentication unchanged without native dual-header opt-in', async () => {
    const fetcher = vi.fn(async (_url: any, options: any) => {
      expect(options.headers['x-api-key']).toBe(key)
      expect(options.headers['anthropic-version']).toBe('2023-06-01')
      expect(options.headers.Authorization).toBeUndefined()
      return reply({ data: [{ id: 'supported' }] })
    })
    expect(
      (await probeAccountModels(api({ apiType: 'anthropic-messages' }), { fetch: fetcher })).models,
    ).toEqual([{ id: 'supported', cost: 'unknown' }])
  })
  it('uses exact current model scope and never includes denied/hidden or token echo entries', async () => {
    const fetch = vi.fn(async (_url: unknown, init: any) => {
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('error')
      return reply({
        data: [
          { id: 'supported', pricing: { input: '0', output: '0' } },
          { id: 'paid', pricing: { input: 1, output: 2 } },
          { id: 'unknown', cost: { input: 0, output: 0 } },
          { id: 'hidden', visibility: 'hidden' },
          { id: 'blocked', available: false },
          { id: key },
          { id: `echo-${key}` },
          { id: 'safe-id', name: key },
        ],
      })
    })
    const scope = await probeAccountModels(api(), { fetch: fetch as typeof globalThis.fetch })
    expect(scope.models.map((model) => [model.id, model.cost])).toEqual([
      ['supported', 'free'],
      ['paid', 'paid'],
      ['unknown', 'unknown'],
      ['safe-id', 'unknown'],
    ])
    expect(JSON.stringify(scope)).not.toContain(key)
    expect(scope.source).toBe('account-models')
  })
  it.each([401, 403])('does not let old verified IDs bypass a current %s rejection', async (status) => {
    const scope = await probeAccountModels(api({ verifiedModelIds: ['old-model'] }), {
      fetch: (async () => reply({}, status)) as typeof fetch,
    })
    expect(scope).toMatchObject({ state: 'denied', models: [] })
  })
  it('only preserves a caller-bound verified route when the model-list route is unsupported', async () => {
    const scope = await probeAccountModels(
      api({ customModelIds: ['declared', key], verifiedModelIds: ['verified'] }),
      { fetch: (async () => reply({}, 404)) as typeof fetch },
    )
    expect(scope.models).toEqual([{ id: 'verified', cost: 'unknown' }])
    expect(JSON.stringify(scope)).not.toContain(key)
  })
  it('does not restore declared models after an unknown network failure', async () => {
    const scope = await probeAccountModels(api({ customModelIds: ['declared'] }), {
      fetch: (async () => {
        throw new Error(key)
      }) as typeof fetch,
    })
    expect(scope).toMatchObject({ state: 'unknown', models: [] })
    expect(JSON.stringify(scope)).not.toContain(key)
  })
  it.each([null, false, ''])('does not convert invalid native pricing %s into zero', async (input) => {
    const scope = await probeAccountModels(api(), {
      fetch: (async () => reply({ data: [{ id: 'model', pricing: { input, output: 0 } }] })) as typeof fetch,
    })
    expect(scope.models[0]?.cost).toBe('unknown')
  })
  it('uses OpenRouter user scope and native prompt/completion rates, retaining additional fees', async () => {
    const fetcher = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe('https://openrouter.ai/api/v1/models/user')
      return reply({
        data: [
          { id: 'free', pricing: { prompt: '0', completion: '0', request: '0' } },
          { id: 'request-fee', pricing: { prompt: '0', completion: '0', request: '0.1' } },
        ],
      })
    })
    const scope = await probeAccountModels(
      api({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }),
      { fetch: fetcher as typeof fetch },
    )
    expect(scope.models.map((model) => model.cost)).toEqual(['free', 'paid'])
  })
  it('does not label API coding subscriptions free from per-token zero/default metadata', async () => {
    const scope = await probeAccountModels(api({ provider: 'zhipu-coding-plan' }), {
      fetch: (async () =>
        reply({ data: [{ id: 'model', free: true, pricing: { input: 0, output: 0 } }] })) as typeof fetch,
    })
    expect(scope.models[0]?.cost).toBe('unknown')
  })
  it.each(['free', 'plus', 'unknown'])(
    'uses current Codex scope and available usage plan %s',
    async (plan) => {
      const calls: string[] = []
      const fetcher = async (url: unknown, init: any) => {
        calls.push(String(url))
        expect(init.method).toBe('GET')
        return String(url).includes('/wham/usage')
          ? reply({ plan_type: plan, rate_limit: { allowed: true, limit_reached: false } })
          : reply({
              models: [
                { slug: 'allowed', supported_in_api: true },
                { slug: 'legacy', supported_in_api: false },
                { slug: 'unconfirmed' },
                { slug: 'not-entitled', supported_in_api: true, entitled: false },
              ],
            })
      }
      const scope = await probeAccountModels(oauth(), { fetch: fetcher as typeof fetch })
      expect(scope.models).toEqual([
        { id: 'allowed', cost: plan === 'free' ? 'free' : plan === 'plus' ? 'paid' : 'unknown' },
      ])
      expect(calls).toHaveLength(2)
      expect(scope.models.some((model) => model.id === 'legacy')).toBe(false)
    },
  )
  it('hides Codex models when account quota explicitly denies execution', async () => {
    const scope = await probeAccountModels(oauth(), {
      fetch: (async (url) =>
        String(url).includes('/usage')
          ? reply({ rate_limit: { allowed: false, limit_reached: true } })
          : reply({ models: [{ slug: 'model', supported_in_api: true }] })) as typeof fetch,
    })
    expect(scope).toMatchObject({ state: 'denied', models: [] })
  })
  it('does not refresh expired OAuth or run command credential resolvers', async () => {
    const fetcher = vi.fn()
    expect(
      (
        await probeAccountModels(
          { ...oauth(), credential: { ...oauth().credential, expires: 1 } },
          { fetch: fetcher },
        )
      ).models,
    ).toEqual([])
    expect(
      (
        await probeAccountModels(api({ credential: { type: 'api', key: '!touch SYNTHETIC_MARKER' } }), {
          fetch: fetcher,
        })
      ).models,
    ).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('aborts metadata requests within the explicit deadline without exposing the error', async () => {
    let aborted = false
    const fetcher = async (_url: unknown, init: any) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(new Error(key))
          },
          { once: true },
        ),
      )
    const scope = await probeAccountModels(api(), { fetch: fetcher as typeof fetch, timeoutMs: 50 })
    expect(aborted).toBe(true)
    expect(scope).toMatchObject({ state: 'unknown', models: [] })
    expect(JSON.stringify(scope)).not.toContain(key)
  })
})

it('rejects failed 200 envelopes instead of displaying their cached model array', async () => {
  for (const envelope of [{ success: false }, { allowed: false }, { error: { code: 'invalid_api_key' } }]) {
    const result = await probeAccountModels(api(), {
      fetch: (async () => reply({ ...envelope, data: [{ id: 'stale-free', free: true }] })) as typeof fetch,
    })
    expect(result.models).toEqual([])
    expect(result.state).not.toBe('supported')
  }
})

it('does not manufacture account scope from a custom model declaration when /models is unavailable', async () => {
  const result = await probeAccountModels(api({ customModelIds: ['declared-only'] }), {
    fetch: (async () => reply({}, 404)) as typeof fetch,
  })
  expect(result).toMatchObject({ state: 'unknown', models: [] })
})
