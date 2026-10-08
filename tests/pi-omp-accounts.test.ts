import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { preparePiOmpAccountTerminal } from '../src/host/pi-omp-accounts.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'

const exec = promisify(execFile)
const roots: string[] = []
const fixtureKey = 'SYNTHETIC_ACCOUNT_KEY_NOT_A_CREDENTIAL'
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(cli: 'pi' | 'omp') {
  const root = await mkdtemp(join(tmpdir(), 'cwn-account-launch-fixture-'))
  roots.push(root)
  const project = join(root, 'project')
  await mkdir(project)
  const resolveCredential = vi.fn().mockResolvedValue(fixtureKey)
  return {
    root,
    input: {
      cli,
      executable: cli === 'pi' ? '/fixture/pi/cli.js' : '/fixture/omp',
      project,
      stateDirectory: join(root, 'state'),
      nativeHome: root,
      config: { ...DEFAULT_CONFIG, zaiCredentialRef: 'fixture:zai-cn', resolveCredential },
    },
    resolveCredential,
  }
}

it.each(['pi', 'omp'] as const)('%s ignores Host credentials in account terminals', async (cli) => {
  const { input, resolveCredential } = await fixture(cli)
  const launch = await preparePiOmpAccountTerminal(input)
  expect(resolveCredential).not.toHaveBeenCalled()
  expect(launch.env.ZAI_CODING_CN_API_KEY).toBeUndefined()
  expect(JSON.stringify(launch.argv)).not.toContain(fixtureKey)
  expect(launch.instruction).toContain('/login')
  expect(launch.instruction).not.toContain(fixtureKey)
  expect(launch.cwd).not.toBe(input.project)
  expect(launch.env.PI_CODING_AGENT_DIR).toBe(
    await realpath(join(input.stateDirectory, 'accounts', cli, 'agent')),
  )
  expect(launch.env.TMPDIR).toBe(join(launch.cwd, 'tmp'))
  expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1')
  expect(launch.env.OMP_PROFILE).toBe('')
  expect(launch.env.PI_PROFILE).toBe('')
  expect(launch.env.HOME).toBeUndefined()
  expect(launch.argv).toContain('--no-session')
  expect(launch.argv).toContain('--no-tools')
  expect(launch.argv).toContain('--no-extensions')
  expect(launch.argv).not.toContain('--print')
  expect(launch.argv).not.toContain('--mode')
  expect(launch.argv).not.toContain('/login')
  expect(launch.argv).not.toContain('auth-broker')
  for (const directory of [launch.cwd, launch.env.PI_CODING_AGENT_DIR, launch.env.TMPDIR])
    expect((await stat(directory!)).mode & 0o777).toBe(0o700)
  for (const name of await readdir(launch.env.PI_CODING_AGENT_DIR!)) {
    const path = join(launch.env.PI_CODING_AGENT_DIR!, name)
    expect(await readFile(path, 'utf8')).not.toContain(fixtureKey)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  }
  await launch.cleanup()
  await launch.cleanup()
  await expect(lstat(launch.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('opens native Pi through Node without imposing a model or sending a prompt', async () => {
  const { input } = await fixture('pi')
  const launch = await preparePiOmpAccountTerminal(input)
  expect(launch.argv.slice(3, 7)).toEqual([
    process.execPath,
    expect.stringContaining('private-launch.mjs'),
    process.execPath,
    input.executable,
  ])
  expect(launch.argv).not.toContain('--provider')
  expect(launch.argv).not.toContain('--model')
  for (const flag of [
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
    '--offline',
  ])
    expect(launch.argv).toContain(flag)
  expect(launch.env.PI_OFFLINE).toBe('1')
  expect(launch.env.PI_TELEMETRY).toBe('0')
  expect(launch.env.PI_CONFIG_DIR).toBeUndefined()
})

it('does not synthesize an OMP CN route and disables automatic fallback before launching', async () => {
  const { input } = await fixture('omp')
  const launch = await preparePiOmpAccountTerminal(input)
  expect(launch.argv.slice(3, 6)).toEqual([
    process.execPath,
    expect.stringContaining('private-launch.mjs'),
    input.executable,
  ])
  expect(launch.env.PI_CONFIG_DIR).toBe(
    relative(homedir(), await realpath(join(input.stateDirectory, 'accounts', 'omp'))),
  )
  const agent = launch.env.PI_CODING_AGENT_DIR!
  const models = JSON.parse(await readFile(join(agent, 'models.yml'), 'utf8'))
  expect(Object.keys(models.providers)).toEqual([])
  expect(JSON.parse(await readFile(join(agent, 'config.yml'), 'utf8'))).toEqual({
    startup: { setupWizard: false, showSplash: false, checkUpdate: false },
    disabledProviders: [
      'native',
      'claude',
      'claude-plugins',
      'codex',
      'cursor',
      'gemini',
      'opencode',
      'mcp-json',
      'vscode',
      'windsurf',
      'omp-plugins',
    ],
    mcp: { enableProjectConfig: false },
    retry: { modelFallback: false },
    memory: { backend: 'off' },
    tools: { approvalMode: 'always-ask' },
  })
  expect(launch.argv).toContain('--no-rules')
  expect(launch.argv).toContain('--no-pty')
  expect(launch.argv).not.toContain('--provider')
  expect(launch.argv).not.toContain('--model')
})

it.each(['pi', 'omp'] as const)(
  '%s permits native account management without a Host credential',
  async (cli) => {
    const { input, resolveCredential } = await fixture(cli)
    resolveCredential.mockResolvedValue(undefined)
    const launch = await preparePiOmpAccountTerminal(input)
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(launch.env.ZAI_CODING_CN_API_KEY).toBeUndefined()
    await launch.cleanup()
  },
)

it('does not look up a guessed credential reference', async () => {
  const { input, resolveCredential } = await fixture('pi')
  const launch = await preparePiOmpAccountTerminal({
    ...input,
    config: { ...input.config, zaiCredentialRef: undefined },
  })
  expect(launch.env.ZAI_CODING_CN_API_KEY).toBeUndefined()
  expect(launch.argv).not.toContain('--model')
  await launch.cleanup()
  expect(resolveCredential).not.toHaveBeenCalled()
})

it('does not invoke failing or stalled Host credential resolvers', async () => {
  for (const resolver of [
    vi.fn().mockRejectedValue(new Error(fixtureKey)),
    vi.fn(() => new Promise<string>(() => {})),
  ]) {
    const { input } = await fixture('pi')
    const launch = await preparePiOmpAccountTerminal({
      ...input,
      config: { ...input.config, resolveCredential: resolver },
    })
    expect(resolver).not.toHaveBeenCalled()
    expect(JSON.stringify(launch)).not.toContain(fixtureKey)
    await launch.cleanup()
  }
})

it('cancels before creating a terminal runtime', async () => {
  const { input, resolveCredential } = await fixture('pi')
  const controller = new AbortController()
  controller.abort(new Error('fixture cancelled'))
  await expect(preparePiOmpAccountTerminal({ ...input, signal: controller.signal })).rejects.toThrow(
    'fixture cancelled',
  )
  expect(resolveCredential).not.toHaveBeenCalled()
  await expect(lstat(input.stateDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['root', 'account-runtime'])(
  'rejects a %s symlink without touching the external target',
  async (level) => {
    const { input, root } = await fixture('omp')
    const external = join(root, 'external')
    await mkdir(external)
    await chmod(external, 0o755)
    if (level === 'account-runtime') await mkdir(input.stateDirectory)
    await symlink(
      external,
      level === 'root' ? input.stateDirectory : join(input.stateDirectory, 'account-runtime'),
    )
    await expect(preparePiOmpAccountTerminal(input)).rejects.toThrow('symlink')
    expect(await readdir(external)).toEqual([])
    expect((await stat(external)).mode & 0o777).toBe(0o755)
  },
)

it('keeps separate ephemeral account runtimes and never writes the project', async () => {
  const { input } = await fixture('pi')
  const first = await preparePiOmpAccountTerminal(input)
  const second = await preparePiOmpAccountTerminal(input)
  expect(first.cwd).not.toBe(second.cwd)
  await first.cleanup()
  expect((await stat(second.cwd)).isDirectory()).toBe(true)
  expect(await readdir(input.project)).toEqual([])
})

it.each(['pi', 'omp'] as const)(
  '%s launch wrapper applies a private umask and passes only argv, without sending a task',
  async (cli) => {
    const { input, root } = await fixture(cli)
    const executable = join(root, 'simulated-cli.mjs')
    // Synthetic CLI process: records safe metadata only; no login, network, or model is involved.
    await writeFile(
      executable,
      `import {writeFileSync} from 'node:fs'; writeFileSync('observed.json', JSON.stringify({ args: process.argv.slice(2), keyPresent: process.env.ZAI_CODING_CN_API_KEY === ${JSON.stringify(fixtureKey)}, mask: process.umask() }));`,
    )
    const launch = await preparePiOmpAccountTerminal({ ...input, executable })
    await exec(launch.argv[0]!, launch.argv.slice(1), { cwd: launch.cwd, env: launch.env, timeout: 5000 })
    const observed = JSON.parse(await readFile(join(launch.cwd, 'observed.json'), 'utf8'))
    expect(observed.keyPresent).toBe(false)
    expect(observed.mask).toBe(0o077)
    expect(observed.args).toContain('--no-tools')
    expect(observed.args).not.toContain('--print')
    expect((await stat(join(launch.cwd, 'observed.json'))).mode & 0o777).toBe(0o600)
  },
)

it('passes the prepared OMP settings file to the native overlay flag without faking setup completion', async () => {
  const { input } = await fixture('omp')
  const launch = await preparePiOmpAccountTerminal(input)
  const configFlag = launch.argv.indexOf('--config')
  expect(configFlag).toBeGreaterThan(0)
  const path = launch.argv[configFlag + 1]!
  expect(path).toBe(join(launch.env.PI_CODING_AGENT_DIR!, 'config.yml'))
  const config = JSON.parse(await readFile(path, 'utf8'))
  expect(config.startup.setupWizard).toBe(false)
  expect(config.startup.checkUpdate).toBe(false)
  expect(config.setupVersion).toBeUndefined()
  expect(launch.argv).not.toContain('setup')
  expect(launch.argv).not.toContain('login')
  expect(launch.argv).not.toContain('--api-key')
  expect(await readdir(launch.env.PI_CODING_AGENT_DIR!)).toEqual([
    'agent.db',
    'config.yml',
    'models.db',
    'models.yml',
    'native-auth.json',
    'native-env.json',
  ])
})

it('disables verified OMP MCP discovery sources without disabling its selected API provider', async () => {
  const { input } = await fixture('omp')
  const launch = await preparePiOmpAccountTerminal(input)
  const config = JSON.parse(await readFile(join(launch.env.PI_CODING_AGENT_DIR!, 'config.yml'), 'utf8'))
  const nativeMcpSources = [
    'native',
    'claude',
    'claude-plugins',
    'codex',
    'cursor',
    'gemini',
    'opencode',
    'mcp-json',
    'vscode',
    'windsurf',
    'omp-plugins',
  ]
  expect(new Set(config.disabledProviders)).toEqual(new Set(nativeMcpSources))
  expect(config.mcp.enableProjectConfig).toBe(false)
  const provider = launch.argv[launch.argv.indexOf('--provider') + 1]
  expect(config.disabledProviders).not.toContain(provider)
  expect(launch.argv).not.toContain('--no-mcp')
  expect(launch.env.PI_NO_MCP).toBeUndefined()
})

it.each(['pi', 'omp'] as const)(
  '%s opens native login without resolving a subscription and preserves accounts after close',
  async (cli) => {
    const { input, resolveCredential } = await fixture(cli)
    const launch = await preparePiOmpAccountTerminal({
      ...input,
      action: 'login',
      config: { ...input.config, zaiCredentialRef: undefined },
    })
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(launch.env.ZAI_CODING_CN_API_KEY).toBeUndefined()
    expect(launch.argv).not.toContain('--model')
    if (cli === 'omp') expect(launch.argv.slice(-2)).toEqual([input.executable, 'setup'])
    else expect(launch.argv.at(-2)).toContain('pi-login.mjs')
    const account = join(launch.env.PI_CODING_AGENT_DIR!, 'auth-fixture.json')
    await writeFile(account, '{"fixture":true}', { mode: 0o600 })
    await launch.cleanup()
    expect(await readFile(account, 'utf8')).toContain('fixture')
    await expect(lstat(launch.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each(['pi', 'omp'] as const)(
  '%s account terminal blocks ambient dotenv reads but retains own projected env and OAuth files',
  async (cli) => {
    const { root, input } = await fixture(cli),
      agent = join(input.stateDirectory, 'accounts', cli, 'agent')
    await mkdir(agent, { recursive: true, mode: 0o700 })
    await writeFile(join(agent, '.env'), 'FIXTURE_API_KEY=SYNTHETIC_OWN_ACCOUNT\n', { mode: 0o600 })
    await writeFile(join(agent, 'oauth-fixture.json'), '{"synthetic":true}', { mode: 0o600 })
    const paths = [
      join(root, '.env'),
      join(input.project, '.env'),
      join(input.project, '.env.local'),
      join(agent, '.env'),
    ]
    for (const path of paths.slice(0, -1)) await writeFile(path, 'OTHER_API_KEY=SYNTHETIC_FOREIGN\n')
    const executable = join(root, 'synthetic-account.js')
    await writeFile(
      executable,
      `import { readFileSync, writeFileSync } from 'node:fs';
const denied=${JSON.stringify(paths)}.map(path=>{try{readFileSync(path);return false}catch{return true}});
writeFileSync('observed.json',JSON.stringify({denied,own:process.env.FIXTURE_API_KEY,oauth:JSON.parse(readFileSync(${JSON.stringify(join(agent, 'oauth-fixture.json'))},'utf8')).synthetic}));`,
    )
    const launch = await preparePiOmpAccountTerminal({ ...input, executable })
    try {
      await exec(launch.argv[0]!, launch.argv.slice(1), { cwd: launch.cwd, env: launch.env, timeout: 5000 })
      expect(JSON.parse(await readFile(join(launch.cwd, 'observed.json'), 'utf8'))).toEqual({
        denied: [true, true, true, true],
        own: 'SYNTHETIC_OWN_ACCOUNT',
        oauth: true,
      })
      expect(await readFile(join(agent, '.env'), 'utf8')).toBe('FIXTURE_API_KEY=SYNTHETIC_OWN_ACCOUNT\n')
    } finally {
      await launch.cleanup()
    }
  },
)

it('OMP login permits its native sibling logs only, without opening the account root or another CLI', async () => {
  const { root, input } = await fixture('omp')
  const launch = await preparePiOmpAccountTerminal({ ...input, action: 'login' })
  const agent = launch.env.PI_CODING_AGENT_DIR!
  const account = join(agent, '..')
  const logs = await realpath(join(account, 'logs'))
  const foreign = join(input.stateDirectory, 'accounts/pi/agent')
  await mkdir(foreign, { recursive: true })
  const attempts = [join(account, 'root-write'), join(foreign, 'other-account'), join(root, 'outside')]
  const script = `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(logs, 'omp.synthetic.log'))}, 'synthetic log');
writeFileSync(${JSON.stringify(join(agent, 'synthetic-auth.json'))}, '{}');
const denied=${JSON.stringify(attempts)}.map(path=>{try{writeFileSync(path,'forbidden');return false}catch{return true}});
writeFileSync('observed.json',JSON.stringify({denied}));`
  try {
    // The real generated Seatbelt policy and private umask wrapper, simulated CLI payload only.
    await exec(
      launch.argv[0]!,
      [...launch.argv.slice(1, 5), process.execPath, '--input-type=module', '-e', script],
      { cwd: launch.cwd, env: launch.env, timeout: 5000 },
    )
    expect(JSON.parse(await readFile(join(launch.cwd, 'observed.json'), 'utf8'))).toEqual({
      denied: [true, true, true],
    })
    expect(await readFile(join(logs, 'omp.synthetic.log'), 'utf8')).toBe('synthetic log')
    expect((await stat(logs)).mode & 0o777).toBe(0o700)
    expect((await stat(join(logs, 'omp.synthetic.log'))).mode & 0o777).toBe(0o600)
  } finally {
    await launch.cleanup()
  }
  expect(await readFile(join(agent, 'synthetic-auth.json'), 'utf8')).toBe('{}')
  await expect(stat(launch.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
})
