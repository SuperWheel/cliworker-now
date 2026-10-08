import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverOpenCode, prepareOpenCode } from '../src/host/opencode-adapter.ts'
import {
  assertOpenCodeManagedAuth,
  inspectOpenCodeProfile,
  readOpenCodeProfile,
  snapshotOpenCodeAuth,
} from '../src/host/opencode-native.ts'

// Entirely synthetic sources and metadata; never invoke a native CLI or network.
const roots: string[] = []
const oauth = (access = 'SYNTHETIC-ACCESS') => ({
  type: 'oauth',
  access,
  refresh: 'SYNTHETIC-REFRESH',
  expires: Date.now() + 3600000,
  accountId: 'synthetic-account',
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cwn-opencode-oauth-block-'))
  roots.push(root)
  const nativeHome = join(root, 'home'),
    authDirectory = join(root, 'plugin/auth'),
    stateDirectory = join(root, 'worker')
  const file = join(nativeHome, '.local/share/opencode/auth.json')
  mkdirSync(join(nativeHome, '.local/share/opencode'), { recursive: true })
  writeFileSync(file, JSON.stringify({ openai: oauth() }), { mode: 0o600 })
  const input = {
    executable: '/synthetic/opencode',
    project: '/synthetic/project',
    preference: { model: 'openai/gpt-synthetic', effort: 'default' },
    mode: 'plan' as const,
    prompt: 'Synthetic only',
    stateDirectory,
    authDirectory,
    nativeHome,
  }
  return { root, file, nativeHome, authDirectory, stateDirectory, input }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('reports an existing native OAuth account while refusing its model catalog and generation path', async () => {
  const f = fixture(),
    capture = vi.fn(),
    fetch = vi.fn(),
    before = readFileSync(f.file, 'utf8')
  expect(await inspectOpenCodeProfile(f.authDirectory, f.input)).toMatchObject({
    state: 'configured',
    authMethod: 'oauth',
    verification: 'local',
  })
  await expect(
    discoverOpenCode('/synthetic/opencode', capture, f.stateDirectory, f.authDirectory, false, {
      nativeHome: f.nativeHome,
      probeOptions: { fetch },
    }),
  ).rejects.toThrow('OAuth 暂无法安全续期')
  await expect(prepareOpenCode(f.input)).rejects.toThrow('OAuth 暂无法安全续期')
  expect(capture).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(readFileSync(f.file, 'utf8')).toBe(before)
  expect(existsSync(f.stateDirectory)).toBe(false)
  expect(existsSync(f.authDirectory)).toBe(false)
})

it.each([1, Date.now() + 3600000])(
  'never snapshots OAuth credentials even if the token expiry is %s',
  async (expires) => {
    const f = fixture(),
      auth = { openai: { ...oauth(), expires } }
    await expect(snapshotOpenCodeAuth(f.authDirectory, auth, ['openai'])).rejects.toThrow(
      'OAuth 暂无法安全续期',
    )
    expect(existsSync(f.authDirectory)).toBe(false)
  },
)

it('keeps API models usable without copying or probing any unselected native OAuth source', async () => {
  const f = fixture()
  mkdirSync(join(f.authDirectory, 'opencode'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(f.authDirectory, 'opencode/auth.json'),
    JSON.stringify({ fixture: { type: 'api', key: 'SYNTHETIC-OWN-API' } }),
    { mode: 0o600 },
  )
  const capture = vi.fn(async (_argv, env) => {
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).enabled_providers).toEqual(['fixture'])
    const copied = JSON.parse(readFileSync(join(env.XDG_DATA_HOME, 'opencode/auth.json'), 'utf8'))
    expect(Object.keys(copied)).toEqual(['fixture'])
    expect(JSON.stringify(copied)).not.toContain('SYNTHETIC-REFRESH')
    return (
      'fixture/model\n' +
      JSON.stringify({
        providerID: 'fixture',
        id: 'model',
        variants: {},
        api: { id: 'model', url: 'https://synthetic.example/v1', npm: '@ai-sdk/openai-compatible' },
      }) +
      '\n'
    )
  })
  const fetch = vi.fn(async (_url, init) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer SYNTHETIC-OWN-API')
    return new Response(JSON.stringify({ data: [{ id: 'model' }] }))
  })
  expect(
    (
      await discoverOpenCode('/synthetic/opencode', capture, f.stateDirectory, f.authDirectory, false, {
        nativeHome: f.nativeHome,
        probeOptions: { fetch },
      })
    ).map((model) => model.id),
  ).toEqual(['fixture/model'])
  const prepared = await prepareOpenCode({
    ...f.input,
    preference: { model: 'fixture/model', effort: 'default' },
  })
  expect(prepared.argv[0]).toBe('/synthetic/opencode')
  expect(prepared.env.XDG_DATA_HOME).not.toContain('/home/')
  expect(JSON.parse(readFileSync(join(prepared.env.XDG_DATA_HOME!, 'opencode/auth.json'), 'utf8'))).toEqual({
    fixture: { type: 'api', key: 'SYNTHETIC-OWN-API' },
  })
  expect(JSON.parse(readFileSync(f.file, 'utf8')).openai.refresh).toBe('SYNTHETIC-REFRESH')
})

it('does not fall back to a global API account when the current plugin source selects OAuth for that provider', async () => {
  const f = fixture()
  writeFileSync(f.file, JSON.stringify({ openai: { type: 'api', key: 'SYNTHETIC-OLD-API' } }))
  mkdirSync(join(f.authDirectory, 'opencode'), { recursive: true })
  writeFileSync(join(f.authDirectory, 'opencode/auth.json'), JSON.stringify({ openai: oauth() }))
  expect((await readOpenCodeProfile(f.authDirectory, f.input)).auth.openai.type).toBe('oauth')
  await expect(prepareOpenCode(f.input)).rejects.toThrow('OAuth 暂无法安全续期')
})

it('requires account terminals to reject well-known remote configuration but permits own API/OAuth management', async () => {
  const f = fixture(),
    signal = new AbortController().signal
  mkdirSync(join(f.authDirectory, 'opencode'), { recursive: true })
  const file = join(f.authDirectory, 'opencode/auth.json')
  for (const type of ['wellknown', 'unknown']) {
    writeFileSync(file, JSON.stringify({ remote: { type, key: 'SYNTHETIC', token: 'SYNTHETIC' } }))
    await expect(assertOpenCodeManagedAuth(f.authDirectory, signal)).rejects.toThrow('不支持')
  }
  writeFileSync(file, JSON.stringify({ openai: oauth(), fixture: { type: 'api', key: 'SYNTHETIC' } }))
  await expect(assertOpenCodeManagedAuth(f.authDirectory, signal)).resolves.toBeUndefined()
})
