import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  snapshotPiOmpNative,
  inspectPiOmpNativeAccount,
  restorePiOmpEnvironment,
} from '../src/host/pi-omp-native.ts'

// Every path and credential in this suite is synthetic; no user native home is read.
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(cli: 'pi' | 'omp') {
  const root = await mkdtemp(join(tmpdir(), 'cwn-native-config-fixture-'))
  roots.push(root)
  const global = join(root, cli === 'pi' ? '.pi' : '.omp', 'agent'),
    state = join(root, 'state'),
    account = join(state, 'accounts', cli, 'agent'),
    worker = join(root, 'worker')
  for (const path of [global, account, worker]) await mkdir(path, { recursive: true, mode: 0o700 })
  const options = { nativeHome: root, accountRoot: state }
  const status = () =>
    inspectPiOmpNativeAccount(cli, state, new AbortController().signal, { nativeHome: root })
  return { root, global, state, account, worker, options, status }
}
const save = (directory: string, name: string, value: unknown) =>
  writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 })

it('merges Pi native accounts, custom providers and cached models by provider without source writes', async () => {
  const f = await fixture('pi')
  const global = {
    existing: { type: 'api', key: 'SYNTHETIC_GLOBAL_KEY' },
    second: { type: 'api', key: 'SYNTHETIC_SECOND_KEY' },
  }
  await save(f.global, 'auth.json', global)
  await save(f.account, 'auth.json', { existing: { type: 'api', key: 'SYNTHETIC_PLUGIN_KEY' } })
  await save(f.global, 'models.json', {
    providers: {
      existing: {
        api: 'openai-completions',
        baseUrl: 'https://global.test',
        models: [{ id: 'global-model' }],
      },
      second: { models: [{ id: 'second-model' }] },
    },
  })
  await save(f.account, 'models.json', {
    providers: {
      existing: {
        api: 'openai-completions',
        baseUrl: 'https://plugin.test',
        models: [{ id: 'plugin-model' }],
      },
    },
  })
  await save(f.global, 'settings.json', { defaultThinkingLevel: 'medium', extensions: ['DO_NOT_IMPORT'] })
  await save(f.global, 'models-store.json', {
    existing: { models: [{ provider: 'existing', id: 'cached-only-model' }], lastModified: '2099-01-01' },
  })
  await save(f.account, 'models-store.json', {})
  const before = await readFile(join(f.global, 'auth.json'), 'utf8')
  await snapshotPiOmpNative('pi', f.worker, f.options)
  expect(JSON.parse(await readFile(join(f.worker, 'auth.json'), 'utf8'))).toEqual({
    ...global,
    existing: { type: 'api', key: 'SYNTHETIC_PLUGIN_KEY' },
  })
  expect(JSON.parse(await readFile(join(f.worker, 'models.json'), 'utf8')).providers.existing.baseUrl).toBe(
    'https://plugin.test',
  )
  expect(JSON.parse(await readFile(join(f.worker, 'models-store.json'), 'utf8')).existing.models[0].id).toBe(
    'cached-only-model',
  )
  expect(await readFile(join(f.global, 'auth.json'), 'utf8')).toBe(before)
  expect((await f.status()).state).toBe('authenticated')
  expect(JSON.parse(await readFile(join(f.worker, 'settings.json'), 'utf8'))).toEqual({
    defaultThinkingLevel: 'medium',
  })
  expect(await readdir(f.worker)).not.toContain('sessions')
  for (const name of await readdir(f.worker))
    expect((await stat(join(f.worker, name))).mode & 0o777).toBe(0o600)
})
it('does not let an empty plugin auth file obscure a globally configured Pi account', async () => {
  const f = await fixture('pi')
  await save(f.global, 'auth.json', { example: { type: 'api', key: 'SYNTHETIC_GLOBAL_KEY' } })
  await save(f.account, 'auth.json', {})
  expect((await f.status()).state).toBe('authenticated')
  await snapshotPiOmpNative('pi', f.worker, f.options)
  expect(Object.keys(JSON.parse(await readFile(join(f.worker, 'auth.json'), 'utf8')))).toEqual(['example'])
})
it('bases health on the merged Pi account rather than a superseded global credential', async () => {
  const f = await fixture('pi')
  await save(f.global, 'auth.json', {
    example: { type: 'oauth', access: 'SYNTHETIC_ACCESS', refresh: 'SYNTHETIC_REFRESH', expires: 1 },
  })
  await save(f.account, 'auth.json', { example: { type: 'oauth', access: 'SYNTHETIC_EXPIRED', expires: 1 } })
  expect((await f.status()).state).toBe('unauthenticated')
})
it.each(['pi', 'omp'] as const)('%s classifies missing native credentials as unconfigured', async (cli) => {
  expect((await (await fixture(cli)).status()).state).toBe('unconfigured')
})
it.each(['pi', 'omp'] as const)(
  '%s rejects linked native files without reading or mutating their targets',
  async (cli) => {
    for (const type of ['symlink', 'hardlink']) {
      const f = await fixture(cli),
        outside = join(f.root, 'external')
      await writeFile(outside, 'SYNTHETIC_SECRET_FROM_OUTSIDE', { mode: 0o644 })
      const file = join(f.global, cli === 'pi' ? 'auth.json' : 'models.yml')
      if (type === 'symlink') await symlink(outside, file)
      else await link(outside, file)
      const result = await f.status()
      expect(result.state).toBe('unavailable')
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET_FROM_OUTSIDE')
      await expect(snapshotPiOmpNative(cli, f.worker, f.options)).rejects.toThrow('无法安全读取')
      expect(await readFile(outside, 'utf8')).toBe('SYNTHETIC_SECRET_FROM_OUTSIDE')
      expect((await stat(outside)).mode & 0o777).toBe(0o644)
    }
  },
)
it('does not import native command credential helpers into a worker', async () => {
  const f = await fixture('pi')
  await save(f.global, 'models.json', {
    providers: { example: { apiKey: '!echo SYNTHETIC_SECRET', models: [{ id: 'chat' }] } },
  })
  const status = await f.status()
  expect(status.state).toBe('unavailable')
  expect(JSON.stringify(status)).not.toContain('SYNTHETIC_SECRET')
})
function credentialDB(path: string, provider: string, data: unknown, disabled: string | null = null) {
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT); CREATE TABLE personal_history (text TEXT)',
  )
  db.prepare('INSERT INTO auth_credentials VALUES (?,?,?,?)').run(
    provider,
    'oauth',
    JSON.stringify(data),
    disabled,
  )
  db.exec("INSERT INTO personal_history VALUES ('SYNTHETIC_PRIVATE_HISTORY')")
  db.close()
}
it('imports only OMP auth/catalog rows, preserving custom model env and native auth settings', async () => {
  const f = await fixture('omp')
  credentialDB(join(f.global, 'agent.db'), 'native-oauth', {
    access: 'SYNTHETIC_ACCESS',
    refresh: 'SYNTHETIC_REFRESH',
    expires: 1,
  })
  await save(f.global, 'models.yml', {
    providers: {
      custom: {
        api: 'openai-completions',
        apiKey: 'CUSTOM_KEY',
        baseUrl: 'CUSTOM_BASE_URL',
        models: [{ id: 'custom-model' }],
      },
    },
  })
  await save(f.global, 'config.yml', {
    auth: { accountRotation: { enabled: false } },
    extensions: ['DO_NOT_IMPORT'],
    tools: { approvalMode: 'yolo' },
  })
  await writeFile(
    join(f.global, '.env'),
    'CUSTOM_KEY=SYNTHETIC_NATIVE_ENV\nCUSTOM_BASE_URL=https://custom.test\nPATH=/untrusted\nOTHER_VARIABLE=unrelated\n',
    {
      mode: 0o600,
    },
  )
  const sourceBefore = await readFile(join(f.global, 'agent.db'))
  const snapshot = await snapshotPiOmpNative('omp', f.worker, f.options)
  expect(snapshot.env.CUSTOM_KEY).toBe('SYNTHETIC_NATIVE_ENV')
  expect(snapshot.env.PATH).toBeUndefined()
  expect(snapshot.env.CUSTOM_BASE_URL).toBe('https://custom.test')
  expect(snapshot.env.OTHER_VARIABLE).toBeUndefined()
  expect(JSON.parse(await readFile(join(f.worker, 'native-auth.json'), 'utf8'))).toEqual({
    auth: { accountRotation: { enabled: false } },
  })
  const db = new DatabaseSync(join(f.worker, 'agent.db'), { readOnly: true })
  try {
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='personal_history'").all(),
    ).toEqual([])
    expect(db.prepare('SELECT provider FROM auth_credentials').all()).toEqual([{ provider: 'native-oauth' }])
  } finally {
    db.close()
  }
  expect((await f.status()).state).toBe('authenticated')
  expect((await readFile(join(f.global, 'agent.db'))).equals(sourceBefore)).toBe(true)
})
it('rebuilds continuation credentials from current own sources, never the worker copy', async () => {
  const f = await fixture('pi')
  await save(f.global, 'auth.json', {
    first: { type: 'oauth', access: 'SYNTHETIC_OLD', refresh: 'SYNTHETIC_OLD_REFRESH', expires: 1 },
  })
  await writeFile(join(f.global, '.env'), 'FIRST_API_KEY=SYNTHETIC_ENV\n', { mode: 0o600 })
  await snapshotPiOmpNative('pi', f.worker, f.options)
  await save(f.worker, 'auth.json', {
    first: {
      type: 'oauth',
      access: 'SYNTHETIC_REFRESHED',
      refresh: 'SYNTHETIC_NEW_REFRESH',
      expires: 9999999999999,
    },
  })
  await save(f.global, 'auth.json', {
    first: { type: 'oauth', access: 'SYNTHETIC_OLD', refresh: 'SYNTHETIC_OLD_REFRESH', expires: 1 },
    second: { type: 'api', key: 'SYNTHETIC_NEW_PROVIDER' },
  })
  await save(f.global, 'models.json', {
    providers: {
      second: { api: 'openai-completions', baseUrl: 'https://second.test', models: [{ id: 'second-model' }] },
    },
  })
  await snapshotPiOmpNative('pi', f.worker, { ...f.options, preserveCredentials: true })
  const auth = JSON.parse(await readFile(join(f.worker, 'auth.json'), 'utf8'))
  expect(auth.first.access).toBe('SYNTHETIC_OLD')
  expect(auth.second.type).toBe('api')
  expect((await restorePiOmpEnvironment(f.worker)).FIRST_API_KEY).toBe('SYNTHETIC_ENV')
  expect(
    JSON.parse(await readFile(join(f.worker, 'models.json'), 'utf8')).providers.second.models[0].id,
  ).toBe('second-model')
})

it.each(['pi', 'omp'] as const)('%s cannot revive a logged-out source from old worker files', async (cli) => {
  const f = await fixture(cli)
  if (cli === 'pi') await save(f.global, 'auth.json', { fixture: { type: 'api', key: 'SYNTHETIC_OWN' } })
  else
    credentialDB(join(f.global, 'agent.db'), 'fixture', {
      access: 'SYNTHETIC_OWN',
      refresh: 'SYNTHETIC_REFRESH',
      expires: 9999999999999,
    })
  await writeFile(join(f.global, '.env'), 'FIXTURE_API_KEY=SYNTHETIC_OWN_ENV\n')
  await snapshotPiOmpNative(cli, f.worker, f.options)
  await rm(join(f.global, cli === 'pi' ? 'auth.json' : 'agent.db'))
  await rm(join(f.global, '.env'))
  const refreshed = await snapshotPiOmpNative(cli, f.worker, { ...f.options, preserveCredentials: true })
  expect(refreshed.configured).toBe(false)
  expect(await restorePiOmpEnvironment(f.worker)).toEqual({})
  if (cli === 'pi') expect(JSON.parse(await readFile(join(f.worker, 'auth.json'), 'utf8'))).toEqual({})
  else {
    const db = new DatabaseSync(join(f.worker, 'agent.db'))
    try {
      expect(db.prepare('SELECT * FROM auth_credentials').all()).toEqual([])
    } finally {
      db.close()
    }
  }
})

it('discards only the known Host-only OMP route and excludes remote auth brokers', async () => {
  const f = await fixture('omp')
  const legacy = {
    api: 'openai-completions',
    apiKey: 'ZAI_CODING_CN_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    models: [{ id: 'glm-5.3-flash' }],
  }
  await save(f.account, 'models.yml', {
    providers: { 'cliworker-zai-cn': legacy, own: { apiKey: 'SYNTHETIC_OWN' } },
  })
  await save(f.account, 'config.yml', {
    auth: { broker: { url: 'https://other-account.invalid' }, preference: 'oauth' },
  })
  const before = await readFile(join(f.account, 'models.yml'), 'utf8')
  await snapshotPiOmpNative('omp', f.worker, f.options)
  expect(JSON.parse(await readFile(join(f.worker, 'models.yml'), 'utf8')).providers).toEqual({
    own: { apiKey: 'SYNTHETIC_OWN' },
  })
  expect(JSON.parse(await readFile(join(f.worker, 'native-auth.json'), 'utf8')).auth).toEqual({
    preference: 'oauth',
  })
  expect(await readFile(join(f.account, 'models.yml'), 'utf8')).toBe(before)
  await writeFile(join(f.account, '.env'), 'ZAI_CODING_CN_API_KEY=SYNTHETIC_EXPLICIT_OWN\n')
  await snapshotPiOmpNative('omp', f.worker, f.options)
  expect(
    JSON.parse(await readFile(join(f.worker, 'models.yml'), 'utf8')).providers['cliworker-zai-cn'],
  ).toEqual(legacy)
})
