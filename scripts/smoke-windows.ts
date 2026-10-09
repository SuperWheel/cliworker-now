// Actual Windows launch/SDK verification with isolated empty homes. No model
// prompt, login, refresh or production credential is sent by this probe.
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { nativeProcessBackend } from '../src/host/native-process.ts'
import { nativeLaunchArgv } from '../src/host/native-launch.mjs'
import { inspectPiInstallation } from '../src/host/pi-installation.mjs'
import { queryNativeCandidates } from '../src/host/pi-native-catalog.mjs'

if (process.platform !== 'win32') throw new Error('This probe requires actual Windows')
const vendor = process.env.CLIWORKER_VENDOR_ROOT
const ompVendor = process.env.CLIWORKER_OMP_VENDOR_ROOT
if (!vendor || !ompVendor) throw new Error('Install the pinned official CLI fixtures first')
const root = await mkdtemp(join(tmpdir(), 'cliworker-native-windows-'))
const ctx = new Context()
const observed: { cli: string; version: string; actualRuntime: string }[] = []
try {
  for (const name of ['home', 'agent', 'work', 'tmp', 'appdata', 'localappdata'])
    await mkdir(join(root, name))
  await writeFile(join(root, 'agent', 'auth.json'), '{}', { mode: 0o600 })
  await writeFile(join(root, 'agent', 'models.json'), '{}', { mode: 0o600 })
  // These variables belong only to this isolated CI process, not the user's Host.
  process.env.HOME = join(root, 'home')
  process.env.USERPROFILE = join(root, 'home')
  process.env.APPDATA = join(root, 'appdata')
  process.env.LOCALAPPDATA = join(root, 'localappdata')
  process.env.DSH_HOME = join(root, 'home', '.dsh')
  if (homedir() !== join(root, 'home')) throw new Error('Native fixture home is not isolated')
  await ctx.plugin(LocalSubprocessRuntime)
  const backend = nativeProcessBackend(ctx.subprocess)
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
    WINDIR: process.env.WINDIR ?? '',
    COMSPEC: process.env.COMSPEC ?? '',
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    PI_CONFIG_DIR: '.',
    PI_OFFLINE: '1',
    ELECTRON_RUN_AS_NODE: '1',
  }
  const run = async (argv: string[]) => {
    const handle = backend.spawn({
      argv, cwd: join(root, 'work'), env,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      signal: AbortSignal.timeout(30000), graceMs: 500,
    })
    void handle.done.catch(() => undefined)
    let output = '', diagnostic = ''
    const collect = async (stream: typeof handle.stdout, keep: boolean) => {
      if (!stream) return
      for await (const chunk of stream) {
        if (keep) output += String(chunk)
        else diagnostic += String(chunk)
        if (output.length + diagnostic.length > 1024 * 1024)
          throw new Error('Version/help output exceeded bound')
      }
    }
    try {
      await Promise.all([collect(handle.stdout, true), collect(handle.stderr, false)])
      const result = await handle.done
      if (result.exitCode !== 0) throw new Error(`Native fixture failed: ${diagnostic.slice(0, 4000)}`)
      return output.trim()
    } finally {
      handle.terminate()
      if (!(await handle.waitForExit())) throw new Error('Native fixture cleanup unconfirmed')
    }
  }
  for (const [cli, folder, version] of [
    ['codex', vendor, '0.160.0'], ['pi', vendor, '1.0.4'], ['omp', ompVendor, '16.4.4'],
  ]) {
    const shim = join(folder, 'node_modules', '.bin', cli + '.cmd')
    const argv = nativeLaunchArgv([shim, '--version'])
    const output = await run([shim, '--version'])
    if (!output.includes(version)) throw new Error(`${cli} installed version differs`)
    observed.push({ cli, version, actualRuntime: /bun(?:\.exe)?$/i.test(argv[0]!) ? 'Bun' : 'Node/native' })
    console.log(JSON.stringify({ verifiedOfficialEntry: observed.at(-1) }))
    if (cli === 'omp') {
      const help = await run([shim, '--help'])
      for (const capability of ['rpc', '--config', '--session-dir'])
        if (!help.includes(capability)) throw new Error('OMP native capability differs')
    }
  }
  const pi = inspectPiInstallation(join(vendor, 'node_modules', '.bin', 'pi.cmd'))
  const candidates = await queryNativeCandidates('pi', pi.executable, join(root, 'agent'), env)
  if (!Array.isArray(candidates)) throw new Error('Native Pi SDK returned invalid metadata')
  await mkdir(resolve('.test-data'), { recursive: true })
  await writeFile(resolve('.test-data/windows-native-smoke.json'), JSON.stringify({
    platform: process.platform, arch: process.arch, node: process.version,
    officialInstalledCliFixtures: observed, realPiSdkCandidateCount: candidates.length,
    emptyOwnAuth: true, credentialsUsed: 0, promptsSent: 0, modelGeneration: 0,
    scope: 'Actual Windows version/help execution and Pi SDK metadata; no model generation.',
  }, null, 2))
  console.log(JSON.stringify({ passed: true, observed, realPiSdkCandidateCount: candidates.length, modelGeneration: 0 }))
} finally {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}
