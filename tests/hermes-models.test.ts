import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermesAccountModels } from '../src/host/hermes-models.ts'

const roots: string[] = []
function home(provider = 'openrouter') {
  const root = mkdtempSync(join(tmpdir(), 'hermes-models-synthetic-'))
  roots.push(root)
  writeFileSync(join(root, 'config.yaml'), `model:\n  provider: ${provider}\n  default: synthetic/model\n`)
  return root
}
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('Hermes account supported model discovery (synthetic, no real requests)', () => {
  it('does not treat a default model, refresh token or another provider credential as availability', async () => {
    const root = home(),
      fetch = vi.fn()
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=synthetic-unrelated-key\n')
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({
        providers: {
          'openai-codex': {
            auth_mode: 'chatgpt',
            tokens: { refresh_token: 'synthetic-refresh' },
          },
        },
      }),
    )
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses only the current OpenRouter account GET and intersects the native selected model', async () => {
    const root = home(),
      key = 'synthetic-private-api-key'
    writeFileSync(join(root, '.env'), `OPENROUTER_API_KEY=${key}\n`)
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/models/user')
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${key}` })
      return response({
        data: [
          { id: 'synthetic/model', pricing: { input: 0, output: 0 } },
          { id: 'embedding-only' },
          { id: key },
          { id: 'denied', allowed: false },
        ],
      })
    })
    const scope = await hermesAccountModels(root, 'openrouter', { fetch })
    expect(scope.models).toEqual([{ id: 'synthetic/model', cost: 'free' }])
    expect(JSON.stringify(scope)).not.toContain(key)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('requires every native pool identity to support the selected model', async () => {
    const root = home()
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({
        credential_pool: {
          openrouter: [
            { auth_type: 'api_key', access_token: 'synthetic-a' },
            { auth_type: 'api_key', access_token: 'synthetic-b' },
          ],
        },
      }),
    )
    const fetch = vi.fn(async (_url, init) =>
      response({ data: init.headers.Authorization.endsWith('-a') ? [{ id: 'synthetic/model' }] : [] }),
    )
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('intersects numbered env credentials and rehydrates env-backed pool rows', async () => {
    const root = home()
    writeFileSync(
      join(root, '.env'),
      'OPENROUTER_API_KEY=synthetic-current\nOPENROUTER_API_KEY_2=synthetic-second',
    )
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({
        credential_pool: {
          openrouter: [
            { source: 'env:OPENROUTER_API_KEY', auth_type: 'api_key', access_token: 'synthetic-stale' },
          ],
        },
      }),
    )
    const seen: string[] = []
    const fetch = vi.fn(async (_url, init) => {
      seen.push(init.headers.Authorization)
      return response({
        data: init.headers.Authorization.endsWith('current') ? [{ id: 'synthetic/model' }] : [],
      })
    })
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    expect(seen).toEqual(['Bearer synthetic-current', 'Bearer synthetic-second'])
  })

  it('does not authorize an ignored model.api_key or an unresolved environment secret', async () => {
    const root = home(),
      fetch = vi.fn()
    writeFileSync(
      join(root, 'config.yaml'),
      'model:\n  provider: openrouter\n  default: synthetic/model\n  api_key: synthetic-ignored',
    )
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=op://synthetic/secret')
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never sends a canonical provider credential to an ambiguous custom endpoint or follows a secret symlink', async () => {
    const root = home(),
      fetch = vi.fn()
    writeFileSync(
      join(root, '.env'),
      'OPENROUTER_API_KEY=synthetic-key\nCUSTOM_BASE_URL=https://wrong.invalid/v1\n',
    )
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    rmSync(join(root, '.env'))
    const external = join(home(), 'secret')
    writeFileSync(external, 'OPENROUTER_API_KEY=synthetic-key')
    symlinkSync(external, join(root, '.env'))
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hides rejected, malformed, unavailable and expired credentials without refreshing OAuth', async () => {
    const root = home()
    writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=synthetic-key')
    for (const status of [401, 403, 404, 500]) {
      const fetch = vi.fn(async () => response({}, status))
      expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    }
    const codex = home('openai-codex'),
      fetch = vi.fn()
    const access = `synthetic.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`
    writeFileSync(
      join(codex, 'auth.json'),
      JSON.stringify({
        providers: {
          'openai-codex': {
            auth_mode: 'chatgpt',
            tokens: { access_token: access, refresh_token: 'synthetic-refresh' },
          },
        },
      }),
    )
    expect((await hermesAccountModels(codex, 'openai-codex', { fetch })).state).toBe('denied')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels outstanding metadata requests and propagates cancellation', async () => {
    const root = home(),
      controller = new AbortController()
    writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=synthetic-key')
    const fetch = vi.fn(async (_url, init) => {
      controller.abort(new Error('synthetic cancelled'))
      init.signal.throwIfAborted()
      return response({})
    })
    await expect(
      hermesAccountModels(root, 'openrouter', { fetch, signal: controller.signal }),
    ).rejects.toThrow('synthetic cancelled')
  })

  it('does not expose models from a provider explicitly disabled in native configuration', async () => {
    const root = home(),
      fetch = vi.fn()
    writeFileSync(
      join(root, 'config.yaml'),
      'model:\n  provider: openrouter\n  default: synthetic/model\nproviders:\n  openrouter:\n    enabled: false\n',
    )
    writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=synthetic-key')
    expect((await hermesAccountModels(root, 'openrouter', { fetch })).models).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not use Hermes credentials to authorize an external Codex app-server identity', async () => {
    const root = home('openai-codex'),
      fetch = vi.fn()
    writeFileSync(
      join(root, 'config.yaml'),
      'model:\n  provider: openai-codex\n  default: synthetic/model\n  openai_runtime: codex_app_server\n',
    )
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({
        providers: {
          'openai-codex': {
            auth_mode: 'chatgpt',
            tokens: { access_token: 'synthetic-current', expires_at: Date.now() + 60000 },
          },
        },
      }),
    )
    expect((await hermesAccountModels(root, 'openai-codex', { fetch })).models).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})
