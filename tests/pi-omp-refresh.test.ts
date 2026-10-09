import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { extendedLaunch } from '../src/host/extended-adapters.ts'
import { DEFAULT_CONFIG, ProcessCleanupUnconfirmedError } from '../src/host/process.ts'
import { snapshotPiOmpNative } from '../src/host/pi-omp-native.ts'
import { preparePiOmp } from '../src/host/pi-omp-adapter.ts'
import {
  acquireOwnAccountLease,
  ownsOwnAccountLease,
  releaseOwnAccountLease,
  assertOwnAccountLeaseIdle,
} from '../src/host/own-account-lease.mjs'
import {
  assertPiOmpRefreshSources,
  finishPiOmpRefresh,
  refreshFingerprint,
} from '../src/host/pi-omp-refresh.mjs'

// Explicitly simulated source files, SQLite and SDK file lock; no CLI/network/login.
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const credential = (suffix = 'old', accountId = 'synthetic-account') => ({
  type: 'oauth',
  accountId,
  access: `synthetic-access-${suffix}`,
  refresh: `synthetic-refresh-${suffix}`,
  expires: Date.now() + 3600000,
})
async function fixture(cli: 'pi' | 'omp') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oauth-refresh-synthetic-')))
  roots.push(root)
  const source = join(root, `.${cli}/agent`),
    accountRoot = join(root, 'plugin'),
    worker = join(root, 'worker')
  for (const path of [source, accountRoot, worker, join(root, 'project')])
    await mkdir(path, { recursive: true, mode: 0o700 })
  const path = join(source, cli === 'pi' ? 'auth.json' : 'agent.db')
  const original = credential()
  const set = async (value: any, includeApi = false) => {
    if (cli === 'pi')
      await writeFile(
        path,
        JSON.stringify(
          value
            ? { fixture: value, ...(includeApi ? { second: { type: 'api', key: 'synthetic-api' } } : {}) }
            : {},
        ),
        { mode: 0o600 },
      )
    else {
      const db = new DatabaseSync(path)
      try {
        db.exec(
          'CREATE TABLE IF NOT EXISTS auth_credentials(id INTEGER PRIMARY KEY,provider TEXT,credential_type TEXT,data TEXT,disabled_cause TEXT)',
        )
        db.exec('DELETE FROM auth_credentials')
        if (value) {
          const { type, ...data } = value
          db.prepare('INSERT INTO auth_credentials VALUES(7,?,?,?,NULL)').run(
            'fixture',
            type,
            JSON.stringify(data),
          )
        }
      } finally {
        db.close()
      }
    }
  }
  const get = async () => {
    if (cli === 'pi') return JSON.parse(await readFile(path, 'utf8')).fixture
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const row: any = db.prepare('SELECT data FROM auth_credentials WHERE id=7').get()
      return row ? { ...JSON.parse(row.data), type: 'oauth' } : undefined
    } finally {
      db.close()
    }
  }
  await set(original)
  const sdk = join(root, 'simulated-sdk')
  for (const directory of ['dist/core', 'node_modules/proper-lockfile'])
    await mkdir(join(sdk, directory), { recursive: true })
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.4', type: 'module' }),
  )
  for (const name of [
    'dist/cli.js',
    'dist/index.js',
    'dist/core/model-runtime.js',
    'dist/core/auth-storage.js',
  ])
    await writeFile(join(sdk, name), '// simulated SDK marker only')
  await writeFile(
    join(sdk, 'node_modules/proper-lockfile/index.js'),
    `// Explicit simulated native file lock, no SDK or network.
    const fs=require('fs/promises');exports.lock=async path=>{await fs.mkdir(path+'.lock',{mode:448});return()=>fs.rmdir(path+'.lock')};`,
  )
  const executable = join(sdk, 'dist/cli.js')
  const options = { accountRoot, nativeHome: root, sharedOAuth: true }
  const snapshot = () => snapshotPiOmpNative(cli, worker, options)
  const replaceCache = async (native: Awaited<ReturnType<typeof snapshot>>, value: any) => {
    if (cli === 'pi')
      await writeFile(join(native.directory, 'auth.json'), JSON.stringify({ fixture: value }), {
        mode: 0o600,
      })
    else {
      const db = new DatabaseSync(join(native.directory, 'agent.db'))
      try {
        const { type: _type, ...data } = value
        db.prepare('UPDATE auth_credentials SET data=? WHERE provider=?').run(JSON.stringify(data), 'fixture')
      } finally {
        db.close()
      }
    }
  }
  return {
    root,
    source,
    accountRoot,
    worker,
    path,
    original,
    set,
    get,
    executable,
    options,
    snapshot,
    replaceCache,
  }
}

describe.each(['pi', 'omp'] as const)('%s own-source OAuth refresh (synthetic)', (cli) => {
  it('shares one store, persists only same-account refresh and keeps the next source read current', async () => {
    const f = await fixture(cli),
      a = await f.snapshot()
    const b = await snapshotPiOmpNative(cli, join(f.root, 'another-worker'), f.options)
    expect(a.directory).toBe(b.directory)
    const nonce = randomUUID(),
      refreshed = credential('new')
    await acquireOwnAccountLease(a.leaseDirectory!, nonce)
    await expect(f.snapshot()).rejects.toThrow('账号正被使用')
    await f.replaceCache(a, refreshed)
    await finishPiOmpRefresh(a.leaseDirectory!, nonce, f.executable, a.receipt)
    expect(await f.get()).toEqual(refreshed)
    await expect(assertPiOmpRefreshSources(a.leaseDirectory!, a.receipt)).resolves.toBeTruthy()
    const next = await f.snapshot()
    expect(next.directory).toBe(a.directory)
    expect(next.receipt.entries[0].hash).toBe(refreshFingerprint(refreshed))
    expect((await stat(a.leaseDirectory!)).mode & 0o777).toBe(0o700)
    expect((await stat(join(a.leaseDirectory!, 'receipt.json'))).mode & 0o777).toBe(0o600)
  })

  it.each(['logout', 'delete-file', 'switch-account', 'new-source-token'] as const)(
    'never overwrites %s with a refreshed cache',
    async (change) => {
      const f = await fixture(cli),
        native = await f.snapshot(),
        nonce = randomUUID()
      await acquireOwnAccountLease(native.leaseDirectory!, nonce)
      await f.replaceCache(native, credential('refreshed'))
      if (change === 'logout') await f.set(undefined)
      else if (change === 'delete-file') await rm(f.path)
      else
        await f.set(
          credential('source-changed', change === 'switch-account' ? 'another-account' : 'synthetic-account'),
        )
      const before = await readFile(f.path).catch(() => undefined)
      await expect(
        finishPiOmpRefresh(native.leaseDirectory!, nonce, f.executable, native.receipt),
      ).rejects.toThrow(/账号配置已变化|无法安全保存/)
      expect(await readFile(f.path).catch(() => undefined)).toEqual(before)
      await expect(assertOwnAccountLeaseIdle(native.leaseDirectory!)).resolves.toBeUndefined()
    },
  )

  it('does not trust a runtime-modified receipt or another principal in refreshed credentials', async () => {
    const f = await fixture(cli),
      native = await f.snapshot(),
      nonce = randomUUID()
    const before = await readFile(f.path)
    await acquireOwnAccountLease(native.leaseDirectory!, nonce)
    await writeFile(
      join(native.leaseDirectory!, 'receipt.json'),
      JSON.stringify({
        ...native.receipt,
        entries: [{ ...native.receipt.entries[0], path: '/untrusted/target' }],
      }),
      { mode: 0o600 },
    )
    await f.replaceCache(native, credential('wrong', 'another-account'))
    await expect(
      finishPiOmpRefresh(native.leaseDirectory!, nonce, f.executable, native.receipt),
    ).rejects.toThrow('无法安全保存')
    expect(await readFile(f.path)).toEqual(before)
  })

  it('requires stable identity and never recovers a logged-out source from old cache', async () => {
    const f = await fixture(cli),
      first = await f.snapshot()
    await f.set(undefined)
    const empty = await f.snapshot()
    expect(empty.leaseDirectory).toBeUndefined()
    expect(empty.configured).toBe(false)
    await f.set({ ...credential(), accountId: undefined })
    await expect(f.snapshot()).rejects.toThrow('无法确认 OAuth 续期账号')
    expect(first.leaseDirectory).toBeTruthy()
  })

  it('keeps an unsupported plugin OAuth account from falling back to a global API account', async () => {
    const f = await fixture(cli)
    const plugin = join(f.accountRoot, 'accounts', cli, 'agent')
    await mkdir(plugin, { recursive: true, mode: 0o700 })
    const opaque = { ...credential(), accountId: undefined }
    if (cli === 'pi') {
      await writeFile(
        f.path,
        JSON.stringify({
          fixture: { type: 'api', key: 'synthetic-global-api' },
          second: { type: 'api', key: 'synthetic-other-provider' },
        }),
        { mode: 0o600 },
      )
      await writeFile(join(plugin, 'auth.json'), JSON.stringify({ fixture: opaque }), { mode: 0o600 })
    } else {
      for (const [path, rows] of [
        [
          f.path,
          [
            ['fixture', 'api', { key: 'synthetic-global-api' }],
            ['second', 'api', { key: 'synthetic-other-provider' }],
          ],
        ],
        [join(plugin, 'agent.db'), [['fixture', 'oauth', opaque]]],
      ] as const) {
        const db = new DatabaseSync(path)
        try {
          db.exec(
            'CREATE TABLE IF NOT EXISTS auth_credentials(id INTEGER PRIMARY KEY,provider TEXT,credential_type TEXT,data TEXT,disabled_cause TEXT)',
          )
          db.exec('DELETE FROM auth_credentials')
          for (const [provider, type, data] of rows)
            db.prepare('INSERT INTO auth_credentials(provider,credential_type,data) VALUES(?,?,?)').run(
              provider,
              type,
              JSON.stringify(data),
            )
        } finally {
          db.close()
        }
      }
    }
    const before = await readFile(f.path)
    const snapshot = await f.snapshot()
    expect(snapshot.configured).toBe(true)
    expect(snapshot.leaseDirectory).toBeUndefined()
    if (cli === 'pi') {
      const auth = JSON.parse(await readFile(join(snapshot.directory, 'auth.json'), 'utf8'))
      expect(auth.fixture).toBeUndefined()
      expect(auth.second.key).toBe('synthetic-other-provider')
    } else {
      const db = new DatabaseSync(join(snapshot.directory, 'agent.db'), { readOnly: true })
      try {
        expect(
          db
            .prepare('SELECT provider FROM auth_credentials')
            .all()
            .map((row) => row.provider),
        ).toEqual(['second'])
      } finally {
        db.close()
      }
    }
    expect(await readFile(f.path)).toEqual(before)
  })

  it('rejects another subject even when a shared workspace accountId stays the same', async () => {
    const f = await fixture(cli)
    const jwt = (sub: string) =>
      `e30.${Buffer.from(JSON.stringify({ sub, iss: 'https://synthetic.invalid' })).toString('base64url')}.synthetic`
    const original = { ...credential(), access: jwt('original-user') }
    await f.set(original)
    const native = await f.snapshot(),
      nonce = randomUUID()
    await acquireOwnAccountLease(native.leaseDirectory!, nonce)
    await f.replaceCache(native, { ...credential('refreshed'), access: jwt('different-user') })
    await expect(
      finishPiOmpRefresh(native.leaseDirectory!, nonce, f.executable, native.receipt),
    ).rejects.toThrow('无法安全保存')
    expect(await f.get()).toEqual(original)
  })
})

it('Pi metadata refresh updates the same prepare receipt before its worker activation', async () => {
  const f = await fixture('pi')
  const launch = await preparePiOmp(
    {
      cli: 'pi',
      executable: f.executable,
      project: join(f.root, 'project'),
      stateDirectory: f.worker,
      ...f.options,
      preference: { model: 'fixture/chat', effort: 'default' },
      mode: 'plan',
      prompt: 'synthetic',
    },
    async (argv, _env, phase) => {
      const request = JSON.parse(await readFile(argv.at(-1)!, 'utf8'))
      if (phase === 'account-scope') {
        await writeFile(
          join(request.nativeRoot, 'auth.json'),
          JSON.stringify({ fixture: credential('metadata-refreshed') }),
          { mode: 0o600 },
        )
        return JSON.stringify([{ id: 'fixture/chat', label: 'Simulated', efforts: ['default'] }])
      }
      return JSON.stringify({ phase, count: 1 })
    },
  )
  await launch.activate()
  const request = JSON.parse(await readFile(launch.argv.at(-1)!, 'utf8'))
  await expect(
    assertPiOmpRefreshSources(launch.leaseDirectory!, request.refreshReceipt),
  ).resolves.toBeTruthy()
  await launch.cleanup()
})

it('provider reordering and API changes cannot create another active lease or retain an old API key', async () => {
  const f = await fixture('pi')
  await f.set(f.original, true)
  const initial = await f.snapshot(),
    nonce = randomUUID()
  await acquireOwnAccountLease(initial.leaseDirectory!, nonce)
  await writeFile(
    f.path,
    JSON.stringify({ second: { type: 'api', key: 'new-synthetic-api' }, fixture: f.original }),
    { mode: 0o600 },
  )
  await expect(f.snapshot()).rejects.toThrow('账号正被使用')
  await releaseOwnAccountLease(initial.leaseDirectory!, nonce)
  const next = await f.snapshot()
  expect(next.leaseDirectory).toBe(initial.leaseDirectory)
  expect(JSON.parse(await readFile(join(next.directory, 'auth.json'), 'utf8')).second.key).toBe(
    'new-synthetic-api',
  )
})

it('keeps own API configuration usable while excluding OAuth without a stable principal', async () => {
  const f = await fixture('pi')
  await f.set({ ...credential(), accountId: undefined }, true)
  const snapshot = await f.snapshot()
  expect(snapshot.configured).toBe(true)
  expect(snapshot.leaseDirectory).toBeUndefined()
  const auth = JSON.parse(await readFile(join(snapshot.directory, 'auth.json'), 'utf8'))
  expect(auth.fixture).toBeUndefined()
  expect(auth.second.key).toBe('synthetic-api')
})

it('cancellation cleans only its unpublished lease and never releases a different active owner', async () => {
  const f = await fixture('pi'),
    native = await f.snapshot(),
    interrupted = randomUUID(),
    active = randomUUID()
  const pending = join(native.leaseDirectory!, `.lease-${interrupted}.pending`)
  await mkdir(pending, { mode: 0o700 }) // Simulated termination before owner publication.
  await acquireOwnAccountLease(native.leaseDirectory!, active)
  await releaseOwnAccountLease(native.leaseDirectory!, interrupted)
  expect(await ownsOwnAccountLease(native.leaseDirectory!, active)).toBe(true)
  await expect(stat(pending)).rejects.toMatchObject({ code: 'ENOENT' })
  await releaseOwnAccountLease(native.leaseDirectory!, active)
  const controller = new AbortController()
  controller.abort()
  await expect(
    snapshotPiOmpNative('pi', f.worker, { ...f.options, signal: controller.signal }),
  ).rejects.toThrow()
  await expect(assertOwnAccountLeaseIdle(native.leaseDirectory!)).resolves.toBeUndefined()
})

it('unconfirmed metadata process cleanup never writes refreshes back or releases the lease', async () => {
  const f = await fixture('pi')
  let request: any
  await expect(
    preparePiOmp(
      {
        cli: 'pi',
        executable: f.executable,
        project: join(f.root, 'project'),
        stateDirectory: f.worker,
        ...f.options,
        preference: { model: 'fixture/chat', effort: 'default' },
        mode: 'plan',
        prompt: 'synthetic',
      },
      async (argv) => {
        request = JSON.parse(await readFile(argv.at(-1)!, 'utf8'))
        await writeFile(
          join(request.nativeRoot, 'auth.json'),
          JSON.stringify({ fixture: credential('unconfirmed') }),
          { mode: 0o600 },
        )
        throw new ProcessCleanupUnconfirmedError()
      },
    ),
  ).rejects.toBeInstanceOf(ProcessCleanupUnconfirmedError)
  expect(await f.get()).toEqual(f.original)
  expect(await ownsOwnAccountLease(request.leaseDirectory, request.leaseNonce)).toBe(true)
  // This test has no spawned native process; explicit fixture cleanup is safe.
  await releaseOwnAccountLease(request.leaseDirectory, request.leaseNonce)
})

it(
  'extended launch metadata retains current own OAuth leases without modifying native arguments',
  async () => {
    const f = await fixture('pi')
    vi.stubEnv('HOME', f.root)
    const phases: string[] = []
    const launch = await extendedLaunch(
      'pi',
      f.executable,
      join(f.root, 'project'),
      { model: 'fixture/chat', effort: 'default' },
      'plan',
      'synthetic',
      f.worker,
      { ...DEFAULT_CONFIG, stateDirectory: f.accountRoot },
      undefined,
      async (argv, _env, phase, scope) => {
        phases.push(phase!)
        expect(scope?.leaseDirectory).toBeTruthy()
        expect(argv[0]).toBe(process.execPath)
        expect(argv[1]).toMatch(/private-launch[.]mjs$/)
        expect(argv[2]).toBe(process.execPath)
        expect(argv.join(' ')).not.toMatch(/sandbox-exec|\(deny |\(allow /)
        const request = JSON.parse(await readFile(argv.at(-1)!, 'utf8'))
        expect(request.metadataPhase).toBe(phase)
        expect(request.leaseDirectory).toBe(scope!.leaseDirectory)
        expect(await ownsOwnAccountLease(request.leaseDirectory, request.leaseNonce)).toBe(true)
        expect(await f.get()).toEqual(f.original)
        return phase === 'native-candidates'
          ? JSON.stringify({ phase, count: 1 })
          : JSON.stringify([{ id: 'fixture/chat', label: 'Synthetic', efforts: ['default'] }])
      },
    )
    expect(phases).toEqual(['native-candidates', 'account-scope'])
    await launch.activate?.()
    await launch.cleanup()
    expect(await f.get()).toEqual(f.original)
  },
)
