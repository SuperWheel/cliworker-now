import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { preparePiOmpAccountTerminal } from '../src/host/pi-omp-accounts.ts'
import { listPiOmpAccountSources, inspectPiOmpNativeAccount } from '../src/host/pi-omp-native.ts'
import {
  hermesLogoutPolicy,
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
  expect(launch.argv[2]).toContain('(deny network*)')
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

it.skipIf(process.platform !== 'darwin')(
  'OMP selected source DB and WAL persist deletion through symlink; other source and config stay protected',
  async () => {
    const f = await fixture('omp')
    saveOmp(f.native)
    saveOmp(f.plugin)
    const config = 'auth:\n  broker:\n    url: https://synthetic.invalid\n'
    await writeFile(join(f.native, 'config.yml'), config)
    const launch = await preparePiOmpAccountTerminal({ ...f.input, source: 'native' })
    const agent = launch.env.PI_CODING_AGENT_DIR!
    expect(await realpath(join(agent, 'agent.db'))).toBe(join(f.native, 'agent.db'))
    expect(await readFile(join(agent, 'config.yml'), 'utf8')).not.toContain('broker')
    const code = `
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(${JSON.stringify(join(agent, 'agent.db'))});
db.exec('PRAGMA journal_mode=WAL'); db.exec('DELETE FROM auth_credentials WHERE id=1');
const wal=fs.existsSync(${JSON.stringify(join(f.native, 'agent.db-wal'))});
const denied=[];for(const path of ${JSON.stringify([join(f.plugin, 'agent.db'), join(f.native, 'config.yml'), join(f.native, 'unrelated')])}){try{fs.writeFileSync(path,'unsafe')}catch{denied.push(true)}}
db.close();process.stdout.write(JSON.stringify({wal,denied:denied.length}));`
    try {
      const result = await exec(
        '/usr/bin/sandbox-exec',
        ['-p', launch.argv[2]!, process.execPath, '-e', code],
        { cwd: launch.cwd, env: { PATH: process.env.PATH }, timeout: 10000 },
      )
      expect(JSON.parse(result.stdout)).toEqual({ wal: true, denied: 3 })
      const db = new DatabaseSync(join(f.native, 'agent.db'))
      expect(db.prepare('SELECT * FROM auth_credentials').all()).toEqual([])
      db.close()
      expect(await readFile(join(f.native, 'config.yml'), 'utf8')).toBe(config)
      expect(
        (await listPiOmpAccountSources('omp', f.input.stateDirectory, signal(), { nativeHome: f.root })).map(
          (x) => x.id,
        ),
      ).toEqual(['plugin'])
      expect(
        (await inspectPiOmpNativeAccount('omp', f.input.stateDirectory, signal(), { nativeHome: f.root }))
          .state,
      ).toBe('authenticated')
    } finally {
      await launch.cleanup()
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'Pi source lock/delete stays writable while unrelated source and recreated auth stay blocked',
  async () => {
    const f = await fixture('pi')
    await savePi(f.native)
    await savePi(f.plugin)
    const launch = await preparePiOmpAccountTerminal({ ...f.input, source: 'native' })
    const auth = join(f.native, 'auth.json')
    const code = `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(auth + '.lock')});fs.writeFileSync(${JSON.stringify(auth)},'{}');fs.rmdirSync(${JSON.stringify(auth + '.lock')});let denied=false;try{fs.writeFileSync(${JSON.stringify(join(f.plugin, 'auth.json'))},'{}')}catch{denied=true}process.stdout.write(String(denied));`
    try {
      expect(
        (
          await exec('/usr/bin/sandbox-exec', ['-p', launch.argv[2]!, process.execPath, '-e', code], {
            cwd: launch.cwd,
            timeout: 5000,
          })
        ).stdout,
      ).toBe('true')
      expect(
        (await listPiOmpAccountSources('pi', f.input.stateDirectory, signal(), { nativeHome: f.root })).map(
          (x) => x.id,
        ),
      ).toEqual(['plugin'])
      await rm(auth)
      await expect(
        exec(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            launch.argv[2]!,
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(auth)},'{}')`,
          ],
          { cwd: launch.cwd, timeout: 5000 },
        ),
      ).rejects.toBeDefined()
      expect(existsSync(auth)).toBe(false)
    } finally {
      await launch.cleanup()
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'Hermes logout policy permits native atomic account writes, denies config/history/siblings/network',
  async () => {
    const f = await fixture('pi'),
      home = join(f.root, 'hermes.[native]')
    await mkdir(home)
    for (const name of ['auth.json', '.env', 'config.yaml', 'history.json'])
      await writeFile(join(home, name), '{}')
    const policy = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(join(f.root, 'state'))}))${hermesLogoutPolicy(home)}`
    const code = `const fs=require('node:fs'),p=${JSON.stringify(home)};fs.chmodSync(p,448);for(const [tmp,to]of [['.auth_synthetic.tmp','auth.json'],['.env_synthetic.tmp','.env']]){fs.writeFileSync(p+'/'+tmp,'{}');fs.renameSync(p+'/'+tmp,p+'/'+to)}fs.writeFileSync(p+'/auth.lock','');fs.unlinkSync(p+'/auth.lock');let denied=0;for(const name of ['config.yaml','history.json','unrelated','.auth_nested/evil.tmp'])try{fs.writeFileSync(p+'/'+name,'unsafe')}catch{denied++}process.stdout.write(String(denied));`
    expect(
      (await exec('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, '-e', code], { timeout: 5000 }))
        .stdout,
    ).toBe('4')
    expect(await readFile(join(home, 'config.yaml'), 'utf8')).toBe('{}')
  },
)

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
  expect(launch.argv[2]).toContain('(deny network*)')
  expect(existsSync(join(f.input.stateDirectory, 'accounts', 'hermes-source.json'))).toBe(false)
  await launch.cleanup()
  expect(existsSync(launch.cwd)).toBe(false)
})
