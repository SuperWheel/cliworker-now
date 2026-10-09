import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { preparePiOmpAccountTerminal } from '../src/host/pi-omp-accounts.ts'
import { listPiOmpAccountSources, inspectPiOmpNativeAccount } from '../src/host/pi-omp-native.ts'
import {
  prepareHermesAccount,
  listHermesAccountSources,
} from '../src/host/hermes-accounts.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'

// All accounts and secrets in this suite are explicit synthetic temporary fixtures.
const exec = promisify(execFile)
const roots: string[] = []
const signal = () => new AbortController().signal
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(cli: 'pi' | 'omp') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwn-logout-synthetic-')))
  roots.push(root)
  const native = join(root, cli === 'pi' ? '.pi' : '.omp', 'agent')
  const plugin = join(root, 'state', 'accounts', cli, 'agent')
  for (const path of [native, plugin, join(root, 'project')])
    await mkdir(path, { recursive: true, mode: 0o700 })
  return {
    root,
    native,
    plugin,
    input: {
      cli,
      executable: '/synthetic/cli',
      project: join(root, 'project'),
      stateDirectory: join(root, 'state'),
      nativeHome: root,
      action: 'logout' as const,
      config: DEFAULT_CONFIG,
    },
  }
}
async function savePi(path: string) {
  await writeFile(
    join(path, 'auth.json'),
    JSON.stringify({ anthropic: { type: 'api', key: 'synthetic-test-api' } }),
    { mode: 0o600 },
  )
}
function saveOmp(path: string) {
  const db = new DatabaseSync(join(path, 'agent.db'))
  db.exec(
    'CREATE TABLE auth_credentials(id INTEGER PRIMARY KEY,provider TEXT,credential_type TEXT,data TEXT,disabled_cause TEXT)',
  )
  db.prepare('INSERT INTO auth_credentials VALUES(1,?,?,?,NULL)').run(
    'anthropic',
    'api_key',
    JSON.stringify({ key: 'synthetic-test-api' }),
  )
  db.close()
}

it.each(['pi', 'omp'] as const)(
  '%s requires a current finite source before allocating logout runtime',
  async (cli) => {
    const f = await fixture(cli)
    if (cli === 'pi') {
      await savePi(f.native)
      await savePi(f.plugin)
    } else {
      saveOmp(f.native)
      saveOmp(f.plugin)
    }
    expect(
      await listPiOmpAccountSources(cli, f.input.stateDirectory, signal(), { nativeHome: f.root }),
    ).toEqual([
      { id: 'native', label: 'CLI 全局账号' },
      { id: 'plugin', label: '插件账号' },
    ])
    await expect(preparePiOmpAccountTerminal(f.input)).rejects.toThrow('请选择')
    expect(existsSync(join(f.input.stateDirectory, 'account-runtime'))).toBe(false)
    await rm(join(f.native, cli === 'pi' ? 'auth.json' : 'agent.db'))
    await expect(preparePiOmpAccountTerminal({ ...f.input, source: 'native' })).rejects.toThrow('来源已变化')
    const cancelled = new AbortController()
    cancelled.abort(new Error('fixture cancelled'))
    await expect(
      preparePiOmpAccountTerminal({ ...f.input, source: 'plugin', signal: cancelled.signal }),
    ).rejects.toThrow('fixture cancelled')
  },
)

it('Pi uses selected real auth with private runtime and accurately keeps env/models-only API sources', async () => {
  const f = await fixture('pi')
  await savePi(f.native)
  await writeFile(
    join(f.plugin, 'models.json'),
    JSON.stringify({
      providers: { custom: { apiKey: 'synthetic-api', baseUrl: 'https://synthetic.invalid' } },
    }),
  )
  const launch = await preparePiOmpAccountTerminal({ ...f.input, source: 'native' })
  expect(launch.argv.at(-1)).toBe(join(f.native, 'auth.json'))
  expect(launch.argv).not.toContain(join(f.native, 'models.json'))
  expect(launch.cwd).not.toBe(f.input.project)
  expect(launch.env.PI_OFFLINE).toBe('1')
  expect(launch.argv[0]).toBe(process.execPath)
  expect(launch.argv.join(' ')).not.toMatch(/sandbox-exec|\(deny |\(allow /)
  expect(launch.instruction).toContain('其他来源保留')
  const config = await preparePiOmpAccountTerminal({ ...f.input, source: 'plugin' })
  expect(config.argv.at(-1)).toBe(join(config.env.PI_CODING_AGENT_DIR!, 'auth.json'))
  expect(config.instruction).toContain('原配置中管理')
  await launch.cleanup()
  await launch.cleanup()
  await config.cleanup()
  expect(existsSync(launch.cwd)).toBe(false)
  expect(JSON.parse(await readFile(join(f.native, 'auth.json'), 'utf8')).anthropic).toBeDefined()
})

it('OMP native logout targets the selected real DB, preserves other sources, and keeps runtime private', async () => {
  const f = await fixture('omp')
  saveOmp(f.native)
  saveOmp(f.plugin)
  const config = 'startup:\n  checkUpdate: false\n'
  await writeFile(join(f.native, 'config.yml'), config)
  const other = await readFile(join(f.plugin, 'agent.db'))
  const launch = await preparePiOmpAccountTerminal({ ...f.input, source: 'native' })
  const agent = launch.env.PI_CODING_AGENT_DIR!
  const dbPath = join(agent, 'agent.db')
  const configPath = launch.argv[launch.argv.indexOf('--config') + 1]!
  expect(await realpath(dbPath)).toBe(join(f.native, 'agent.db'))
  expect(configPath).toBe(join(launch.cwd, 'agent', 'config.yml'))
  expect(await readFile(configPath, 'utf8')).not.toContain('broker')
  expect(launch.argv[0]).toBe(process.execPath)
  expect(launch.argv.join(' ')).not.toMatch(/sandbox-exec|\(deny |\(allow /)
  expect(launch.argv).toContain('--no-session')
  expect(launch.argv[launch.argv.indexOf('--session-dir') + 1]).toBe(join(launch.cwd, 'sessions'))
  expect(launch.env.OMP_AUTH_BROKER_URL).toBe('')
  const code = `
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(${JSON.stringify(dbPath)});
db.exec('PRAGMA journal_mode=WAL'); db.exec('DELETE FROM auth_credentials WHERE id=1');
const wal=fs.existsSync(${JSON.stringify(join(f.native, 'agent.db-wal'))});
db.close();process.stdout.write(JSON.stringify({wal}));`
  try {
    const result = await exec(process.execPath, ['-e', code], { cwd: launch.cwd, timeout: 10000 })
    expect(JSON.parse(result.stdout)).toEqual({ wal: true })
    const db = new DatabaseSync(join(f.native, 'agent.db'))
    expect(db.prepare('SELECT * FROM auth_credentials').all()).toEqual([])
    db.close()
    expect(await readFile(join(f.native, 'config.yml'), 'utf8')).toBe(config)
    expect(await readFile(join(f.plugin, 'agent.db'))).toEqual(other)
    expect((await listPiOmpAccountSources('omp', f.input.stateDirectory, signal(), { nativeHome: f.root })).map(x => x.id)).toEqual(['plugin'])
    expect((await inspectPiOmpNativeAccount('omp', f.input.stateDirectory, signal(), { nativeHome: f.root })).state).toBe('authenticated')
  } finally {
    await launch.cleanup()
  }
  expect(existsSync(launch.cwd)).toBe(false)
  expect(existsSync(join(f.native, 'agent.db'))).toBe(true)
})

it('Pi native logout can update its selected source and current reads never restore the old account', async () => {
  const f = await fixture('pi')
  await savePi(f.native)
  await savePi(f.plugin)
  const other = await readFile(join(f.plugin, 'auth.json'), 'utf8')
  const launch = await preparePiOmpAccountTerminal({ ...f.input, source: 'native' })
  const auth = launch.argv.at(-1)!
  const code = `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(auth + '.lock')});fs.writeFileSync(${JSON.stringify(auth)},'{}');fs.rmdirSync(${JSON.stringify(auth + '.lock')});`
  try {
    await exec(process.execPath, ['-e', code], { cwd: launch.cwd, timeout: 5000 })
    expect((await listPiOmpAccountSources('pi', f.input.stateDirectory, signal(), { nativeHome: f.root })).map(x => x.id)).toEqual(['plugin'])
    expect(await readFile(join(f.plugin, 'auth.json'), 'utf8')).toBe(other)
    await rm(auth)
    expect((await listPiOmpAccountSources('pi', f.input.stateDirectory, signal(), { nativeHome: f.root })).map(x => x.id)).toEqual(['plugin'])
  } finally {
    await launch.cleanup()
  }
  expect(existsSync(auth)).toBe(false)
})

it.skipIf(process.platform !== 'win32')('OMP Windows refuses native broker sources without rewriting their configuration', async () => {
  const f = await fixture('omp')
  saveOmp(f.native)
  const config = 'auth:\n  broker:\n    url: https://synthetic.invalid\n'
  await writeFile(join(f.native, 'config.yml'), config)
  const before = await readFile(join(f.native, 'agent.db'))
  await expect(preparePiOmpAccountTerminal({ ...f.input, source: 'native' })).rejects.toThrow('停用账号代理')
  expect(await readFile(join(f.native, 'config.yml'), 'utf8')).toBe(config)
  expect(await readFile(join(f.native, 'agent.db'))).toEqual(before)
  expect(await readdir(join(f.input.stateDirectory, 'account-runtime'))).toEqual([])
})

it('Hermes logout retains the current global source and never creates a plugin marker', async () => {
  const f = await fixture('pi'),
    home = join(f.root, 'hermes')
  await mkdir(home)
  await writeFile(join(home, 'config.yaml'), 'auth:\n  adopt_external_logins: false\n')
  await writeFile(join(home, '.env'), 'OPENAI_API_KEY=synthetic-test-api\n')
  const config = { ...DEFAULT_CONFIG, stateDirectory: f.input.stateDirectory, hermesHome: home }
  expect(await listHermesAccountSources(config, signal())).toEqual([{ id: 'native', label: 'CLI 全局账号' }])
  await expect(
    prepareHermesAccount('logout', '/synthetic/hermes', f.input.project, config, signal(), 'plugin'),
  ).rejects.toThrow('来源已变化')
  const launch = await prepareHermesAccount(
    'logout',
    '/synthetic/hermes',
    f.input.project,
    config,
    signal(),
    'native',
  )
  expect(launch.argv.at(-1)).toBe('auth')
  expect(launch.env.HERMES_HOME).toBe(home)
  expect(launch.argv[0]).toBe(process.execPath)
  expect(launch.argv.join(' ')).not.toMatch(/sandbox-exec|\(deny |\(allow /)
  expect(existsSync(join(f.input.stateDirectory, 'accounts', 'hermes-source.json'))).toBe(false)
  await launch.cleanup()
  expect(existsSync(launch.cwd)).toBe(false)
})
