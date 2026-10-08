import { afterEach, expect, it } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  symlink,
  link,
  lstat,
  rename,
  readdir,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readKimiAccount, prepareKimiAccountDirectory } from '../src/host/kimi-accounts.ts'

// Explicit synthetic native provider JSON and token files. No CLI or network.
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'kimi-account-synthetic-')))
  roots.push(home)
  await mkdir(join(home, 'credentials'), { mode: 0o700 })
  const path = join(home, 'credentials/kimi-code.json')
  const config = {
    providers: { 'managed:kimi-code': { type: 'kimi', oauth: { storage: 'file', key: 'oauth/kimi-code' } } },
    models: {},
  }
  const now = 2_000_000_000_000
  const token = {
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    expires_at: now / 1000 + 60,
  }
  return {
    home,
    path,
    config,
    token,
    set: (value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 }),
    read: (value: unknown = config, signal = new AbortController().signal) =>
      readKimiAccount(JSON.stringify(value), signal, { home, now }),
  }
}

function syntheticJwt(claims: unknown) {
  return [
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'synthetic-signature',
  ].join('.')
}

it('isolates account working directories and project MCP without changing native accounts or trust', async () => {
  const f = await fixture()
  await f.set(f.token)
  await mkdir(join(f.home, '.git'))
  const projectMcp = '{"mcpServers":{"synthetic-project":{"command":"never-run"}}}'
  await writeFile(join(f.home, '.mcp.json'), projectMcp)
  const prepared = await prepareKimiAccountDirectory(
    join(f.home, 'plugin-state'),
    new AbortController().signal,
  )
  expect((await lstat(prepared.cwd)).mode & 0o777).toBe(0o700)
  expect((await lstat(join(prepared.cwd, '.git'))).isDirectory()).toBe(true)
  for (const path of [join(prepared.cwd, '.mcp.json'), join(prepared.cwd, '.kimi-code/mcp.json')]) {
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ mcpServers: {} })
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
  }
  expect(await readdir(prepared.cwd)).toEqual(['.git', '.kimi-code', '.mcp.json'])
  expect(await readFile(join(f.home, '.mcp.json'), 'utf8')).toBe(projectMcp)
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.token)
  await prepared.cleanup()
  await prepared.cleanup()
  await expect(lstat(prepared.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.token)
})

it('does not allocate a cancelled login directory or clean a replaced directory', async () => {
  const f = await fixture(),
    state = join(f.home, 'plugin-state')
  const abort = new AbortController()
  abort.abort(new Error('synthetic-cancel'))
  await expect(prepareKimiAccountDirectory(state, abort.signal)).rejects.toThrow('synthetic-cancel')
  await expect(lstat(state)).rejects.toMatchObject({ code: 'ENOENT' })
  const prepared = await prepareKimiAccountDirectory(state, new AbortController().signal)
  await rename(prepared.cwd, prepared.cwd + '-original')
  await mkdir(prepared.cwd)
  await writeFile(join(prepared.cwd, 'keep'), 'synthetic-replacement')
  await expect(prepared.cleanup()).rejects.toThrow('changed before cleanup')
  expect(await readFile(join(prepared.cwd, 'keep'), 'utf8')).toBe('synthetic-replacement')
})

it.each(['current', 'refreshable', 'native-no-expiry'] as const)(
  'recognizes %s native OAuth without changing token files',
  async (kind) => {
    const f = await fixture()
    await f.set({
      ...f.token,
      expires_at: kind === 'current' ? f.token.expires_at : kind === 'refreshable' ? 1 : 0,
    })
    const before = await readFile(f.path)
    const value = await f.read()
    expect(value).toEqual({
      state: 'authenticated',
      authMethod: 'oauth',
      verification: 'local',
      summary: '已登录 Kimi',
    })
    expect(JSON.stringify(value)).not.toMatch(/synthetic-|token|credentials|\.json/)
    expect(await readFile(f.path)).toEqual(before)
  },
)

it.each(['current', 'refreshable', 'native-no-expiry'] as const)(
  'shows only a masked decoded native account ID for %s OAuth',
  async (kind) => {
    const f = await fixture()
    const id = 'synthetic-account-123abc'
    const accessToken = syntheticJwt({ iss: 'kimi-auth', sub: id, user_id: id })
    await f.set({
      ...f.token,
      access_token: accessToken,
      expires_at: kind === 'current' ? f.token.expires_at : kind === 'refreshable' ? 1 : 0,
    })
    const before = await readFile(f.path)
    const value = await f.read()
    expect(value).toEqual({
      state: 'authenticated',
      authMethod: 'oauth',
      verification: 'local',
      summary: '已登录 Kimi',
      accountLabel: 'Kimi ID · …123abc',
    })
    expect(value).not.toHaveProperty('logins')
    for (const secret of [id, accessToken, f.token.refresh_token, 'synthetic-signature'])
      expect(JSON.stringify(value)).not.toContain(secret)
    expect(await readFile(f.path)).toEqual(before)
  },
)

it.each(['sub', 'user_id'] as const)('supports the native %s identity field alone', async (field) => {
  const f = await fixture()
  await f.set({ ...f.token, access_token: syntheticJwt({ iss: 'kimi-auth', [field]: 'account-abc123' }) })
  expect((await f.read()).accountLabel).toBe('Kimi ID · …abc123')
})

it.each([
  ['no identity', { iss: 'kimi-auth' }],
  ['unknown issuer', { iss: 'synthetic-other-issuer', sub: 'account-abc123' }],
  ['missing issuer', { sub: 'account-abc123' }],
  ['conflicting identities', { iss: 'kimi-auth', sub: 'account-abc123', user_id: 'account-def456' }],
  ['non-string identity', { iss: 'kimi-auth', sub: 123456789 }],
  ['malformed secondary identity', { iss: 'kimi-auth', sub: 'account-abc123', user_id: null }],
  ['API key shape', { iss: 'kimi-auth', sub: 'sk-secret-abc123' }],
  ['token shape', { iss: 'kimi-auth', sub: 'token-secret-abc123' }],
  ['JWT shape', { iss: 'kimi-auth', sub: 'eyJhbGciOiJFUzI1NiJ9' }],
  ['too short to mask', { iss: 'kimi-auth', sub: 'abc123' }],
  ['too long', { iss: 'kimi-auth', sub: 'a'.repeat(129) }],
  ['control character', { iss: 'kimi-auth', sub: 'account-\nabc123' }],
  ['bidi text', { iss: 'kimi-auth', sub: 'account-\u202eabc123' }],
  ['HTML shape', { iss: 'kimi-auth', sub: '<b>account-abc123</b>' }],
  ['email is not a native ID', { iss: 'kimi-auth', sub: 'synthetic@example.invalid' }],
  ['profile is not an ID', { iss: 'kimi-auth', email: 'synthetic@example.invalid', nickname: 'Synthetic' }],
  ['non-object claims', ['account-abc123']],
] as const)('omits unsafe or unconfirmed identity metadata: %s', async (_kind, claims) => {
  const f = await fixture()
  const accessToken = syntheticJwt(claims)
  await f.set({ ...f.token, access_token: accessToken })
  expect(await f.read()).toEqual({
    state: 'authenticated',
    authMethod: 'oauth',
    verification: 'local',
    summary: '已登录 Kimi',
  })
})

it.each([
  'opaque-native-token',
  'header.%%%%.signature',
  'header.bnVsbA.signature',
  'header.e30=.signature',
  `header.${'a'.repeat(16 * 1024 + 1)}.signature`,
])('keeps native login when access-token identity cannot be decoded (case %#)', async (accessToken) => {
  const f = await fixture()
  await f.set({ ...f.token, access_token: accessToken })
  const value = await f.read()
  expect(value.state).toBe('authenticated')
  expect(value.accountLabel).toBeUndefined()
})

it('reads a changed account afresh and removes its label after logout, source switch or expiry', async () => {
  const f = await fixture()
  const token = (id: string) => ({ ...f.token, access_token: syntheticJwt({ iss: 'kimi-auth', sub: id }) })
  await f.set(token('account-abc123'))
  expect((await f.read()).accountLabel).toBe('Kimi ID · …abc123')
  await f.set(token('account-def456'))
  expect((await f.read()).accountLabel).toBe('Kimi ID · …def456')
  await f.set({ ...f.token, access_token: '', refresh_token: f.token.refresh_token })
  expect(await f.read()).toMatchObject({ state: 'unauthenticated' })
  expect((await f.read()).accountLabel).toBeUndefined()
  await f.set({ ...token('account-def456'), refresh_token: '', expires_at: 1 })
  expect(await f.read()).toMatchObject({ state: 'unauthenticated' })
  expect((await f.read()).accountLabel).toBeUndefined()
  await f.set(token('account-def456'))
  f.config.providers['managed:kimi-code'].oauth.key = 'oauth/new-slot'
  expect(await f.read()).toMatchObject({ state: 'unconfigured' })
  expect((await f.read()).accountLabel).toBeUndefined()
})

it('does not treat provider configuration or a stale other slot as logged in', async () => {
  const f = await fixture()
  expect((await f.read()).state).toBe('unconfigured')
  await f.set(f.token)
  f.config.providers['managed:kimi-code'].oauth.key = 'oauth/current-region'
  expect((await f.read()).state).toBe('unconfigured')
  await writeFile(join(f.home, 'credentials/current-region.json'), JSON.stringify(f.token), { mode: 0o600 })
  expect((await f.read()).state).toBe('authenticated')
  await rm(join(f.home, 'credentials/current-region.json'))
  expect((await f.read()).state).toBe('unconfigured')
})

it.each([
  { access_token: '', refresh_token: 'synthetic-old-refresh', expires_at: 0 },
  { refresh_token: 'synthetic-refresh', expires_at: 0 },
  { access_token: 'synthetic-expired', expires_at: 1 },
])('does not revive revoked, refresh-only or expired native records: %j', async (token) => {
  const f = await fixture()
  await f.set(token)
  expect((await f.read()).state).toBe('unauthenticated')
})

it('keeps literal own API configuration distinct from native OAuth login', async () => {
  const f = await fixture()
  expect(await f.read({ providers: { own: { type: 'openai', apiKey: 'synthetic-api' } } })).toMatchObject({
    state: 'configured',
    authMethod: 'api',
  })
  expect((await f.read({ providers: { own: { type: 'openai', apiKey: '$OPENAI_API_KEY' } } })).state).toBe(
    'unconfigured',
  )
  await f.set(f.token)
  expect(
    (
      await f.read({
        providers: { other: { type: 'kimi', oauth: f.config.providers['managed:kimi-code'].oauth } },
      })
    ).state,
  ).not.toBe('authenticated')
})

it.each(['../kimi-code', 'oauth/../kimi-code', 'oauth/a/b', '.', 'oauth/.hidden', 'oauth/\\other'])(
  'rejects unsafe slot %s without exposing it',
  async (slot) => {
    const f = await fixture()
    f.config.providers['managed:kimi-code'].oauth.key = slot
    expect(await f.read()).toEqual({
      state: 'unavailable',
      verification: 'local',
      summary: 'Kimi 登录状态读取失败，请检查配置',
    })
  },
)

it.each(['symlink', 'hardlink', 'parent-symlink', 'malformed', 'oversized', 'wrong-token-type'] as const)(
  'refuses unsafe token source: %s',
  async (kind) => {
    const f = await fixture()
    const other = join(f.home, 'other.json')
    await writeFile(other, JSON.stringify(f.token), { mode: 0o600 })
    if (kind === 'symlink') await symlink(other, f.path)
    else if (kind === 'hardlink') await link(other, f.path)
    else if (kind === 'parent-symlink') {
      await rm(join(f.home, 'credentials'), { recursive: true })
      await mkdir(join(f.home, 'other'))
      await writeFile(join(f.home, 'other/kimi-code.json'), JSON.stringify(f.token))
      await symlink(join(f.home, 'other'), join(f.home, 'credentials'))
    } else if (kind === 'malformed') await writeFile(f.path, '{synthetic-invalid')
    else if (kind === 'oversized') await writeFile(f.path, 'x'.repeat(64 * 1024 + 1))
    else await f.set({ access_token: {}, refresh_token: f.token.refresh_token })
    expect((await f.read()).state).toBe('unavailable')
  },
)

it('keeps unknown storage unknown and propagates cancellation', async () => {
  const f = await fixture()
  await f.set(f.token)
  f.config.providers['managed:kimi-code'].oauth.storage = 'keyring'
  expect((await f.read()).state).toBe('unknown')
  const controller = new AbortController()
  controller.abort(new Error('Synthetic cancelled'))
  await expect(f.read(f.config, controller.signal)).rejects.toThrow('Synthetic cancelled')
})
