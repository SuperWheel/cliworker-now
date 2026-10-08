import { fileURLToPath } from 'node:url'
import {
  mkdirSync,
  lstatSync,
  chmodSync,
  realpathSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  constants,
  type Stats,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CliId, Preference, TaskMode, ModelChoice } from '../shared/types.ts'
import type { RuntimeConfig } from './process.ts'
import { prepareZCode, discoverZCode, zcodeAuthDirectory } from './zcode-adapter.ts'
import {
  preparePiOmp,
  discoverPiOmp,
  type PiOmpMetadataPhase,
  type PiOmpMetadataCapture,
} from './pi-omp-adapter.ts'
import { prepareOpenCode, discoverOpenCode, openCodeAuthDirectory } from './opencode-adapter.ts'
import { prepareHermes, discoverHermes, hermesHomeDirectory } from './hermes-adapter.ts'
import { hermesCommandInstallationHome } from './hermes-installation.ts'
import { hermesSandbox } from './hermes-sandbox.ts'
import { effectiveHermesHome } from './hermes-account-context.ts'
import { prepareGrok, discoverGrok } from './grok-adapter.ts'

export const EXTENDED_CLIS = ['zcode', 'grok', 'omp', 'pi', 'hermes', 'opencode'] as const
export const isExtendedCli = (cli: string): cli is (typeof EXTENDED_CLIS)[number] =>
  (EXTENDED_CLIS as readonly string[]).includes(cli)
// OMP eagerly loads home/project dotenv files, including before CLI parsing.
// Own dotenv values have already been read and projected by Host. This fixed
// basename regex also covers Bun's .env.local / .env.production variants.
export const PI_OMP_ENVIRONMENT_POLICY = '\n(deny file-read-data (regex #"(^|/)[.]env([.][^/]*)?$"))\n'
const privateArgv = (argv: string[]) => [
  process.execPath,
  fileURLToPath(new URL('./private-launch.mjs', import.meta.url)),
  ...argv,
]
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (lstatSync(path).isSymbolicLink()) throw new Error('CLI state directory cannot be a symlink')
  chmodSync(path, 0o700)
  return realpathSync(path)
}
/**
 * Run only after the native process range has exited. Copies can preserve public
 * modes despite umask. Pin each inode before changing it, skip symlinks, and fail
 * closed on hard links rather than chmod a possibly external file.
 */
export function sealPrivateTree(root: string): void {
  const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino
  const ancestors: { path: string; info: Stats }[] = []
  const assertLocations = () => {
    for (const { path, info } of ancestors) {
      const current = lstatSync(path)
      if (current.isSymbolicLink() || !sameInode(current, info))
        throw new Error('CLI private state changed during permission cleanup')
    }
  }
  const visit = (path: string) => {
    assertLocations()
    const info = lstatSync(path)
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) return
    const fd = openSync(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (info.isDirectory() ? constants.O_DIRECTORY : 0),
    )
    try {
      const opened = fstatSync(fd)
      if (!sameInode(info, opened) || info.isDirectory() !== opened.isDirectory())
        throw new Error('CLI private state inode changed during permission cleanup')
      ancestors.push({ path, info: opened })
      try {
        assertLocations()
        if (opened.isFile() && fstatSync(fd).nlink !== 1)
          throw new Error('CLI private state contains a hard-linked file; permissions were not changed')
        fchmodSync(fd, opened.isDirectory() ? 0o700 : 0o600)
        if (opened.isDirectory()) for (const entry of readdirSync(path)) visit(join(path, entry))
      } finally {
        ancestors.pop()
      }
    } finally {
      closeSync(fd)
    }
  }
  visit(root)
}
/** Compatibility only: Host credential references never supply CLI accounts. */
export async function credentialEnvironment(
  _cli: CliId,
  _config: RuntimeConfig,
  _selectedModel?: string,
): Promise<Record<string, string>> {
  return {}
}
/** The new adapters need writable private state even for a read-only project. */
export function confineExtended(
  argv: string[],
  state: string,
  project: string,
  mode: TaskMode,
  temporary?: string,
  authDirectory?: string,
  isolateDotenv = false,
  leaseDirectory?: string,
): string[] {
  if (process.platform !== 'darwin') throw new Error('这些新增 CLI 当前仅验收 macOS 沙箱；本平台暂不能运行')
  const roots = [
    realpathSync(state),
    ...(authDirectory ? [realpathSync(authDirectory)] : []),
    ...(leaseDirectory && isolateDotenv ? [realpathSync(join(leaseDirectory, 'agent'))] : []),
    ...(temporary ? [realpathSync(temporary)] : []),
    ...(mode === 'accept-edits' ? [realpathSync(project)] : []),
  ]
  const leasePolicy = leaseDirectory
    ? `(deny file-write* (subpath ${JSON.stringify(realpathSync(leaseDirectory))}))\n${isolateDotenv ? `(allow file-write* (subpath ${JSON.stringify(realpathSync(join(leaseDirectory, 'agent')))}))\n` : ''}`
    : ''
  const policy = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* ${roots.map((r) => `(subpath ${JSON.stringify(r)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))\n${leasePolicy}${isolateDotenv ? PI_OMP_ENVIRONMENT_POLICY : ''}`
  return ['/usr/bin/sandbox-exec', '-p', policy, ...argv]
}
export async function extendedLaunch(
  cli: CliId,
  executable: string,
  project: string,
  preference: Preference,
  mode: TaskMode,
  prompt: string,
  stateDirectory: string,
  config: RuntimeConfig,
  conversationId?: string,
  metadataCapture?: PiOmpMetadataCapture,
) {
  const state = privateDirectory(stateDirectory)
  const input = { executable, project, preference, mode, prompt, conversationId, stateDirectory: state }
  const metadata: PiOmpMetadataCapture | undefined =
    metadataCapture &&
    (async (argv, env, phase, scope) => {
      const confined = confineExtended(
        privateArgv(argv),
        state,
        state,
        'plan',
        undefined,
        undefined,
        cli === 'pi' || cli === 'omp',
        scope?.leaseDirectory,
      )
      if (phase === 'native-candidates') confined[2] += '\n(deny network*)\n'
      return metadataCapture(confined, { ...env, ELECTRON_RUN_AS_NODE: '1' }, phase, scope)
    })
  const launch =
    cli === 'zcode'
      ? await prepareZCode({
          ...input,
          authDirectory: zcodeAuthDirectory(config.zcodeAuthDirectory, config.stateDirectory),
          builtinConfig: config.zcodeBuiltinConfig,
        })
      : cli === 'pi' || cli === 'omp'
        ? await preparePiOmp(
            {
              ...input,
              cli,
              accountRoot:
                config.stateDirectory ??
                join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cliworker-now'),
            },
            metadata,
          )
        : cli === 'opencode'
          ? await prepareOpenCode({
              ...input,
              authDirectory: openCodeAuthDirectory(config.stateDirectory),
            })
          : cli === 'hermes'
            ? await prepareHermes({ ...input, hermesHome: effectiveHermesHome(config) })
            : cli === 'grok'
              ? await prepareGrok(input)
              : undefined
  if (!launch) throw new Error('未知 CLI')
  const temporary = cli === 'zcode' ? mkdtempSync('/private/tmp/cwn-') : undefined
  if (temporary) chmodSync(temporary, 0o700)
  const env = {
    ...launch.env,
    ...(temporary ? { TMPDIR: temporary } : {}),
    ELECTRON_RUN_AS_NODE: '1',
  }
  try {
    const argv =
      cli === 'hermes'
        ? hermesSandbox(
            privateArgv(launch.argv),
            state,
            project,
            mode,
            effectiveHermesHome(config),
            hermesCommandInstallationHome(launch.argv) ?? hermesHomeDirectory(config.hermesHome),
          )
        : confineExtended(
            privateArgv(launch.argv),
            state,
            project,
            mode,
            temporary,
            cli === 'opencode' ? openCodeAuthDirectory(config.stateDirectory) : undefined,
            cli === 'pi' || cli === 'omp',
            'leaseDirectory' in launch && typeof launch.leaseDirectory === 'string'
              ? launch.leaseDirectory
              : undefined,
          )
    if (cli === 'grok') {
      const grokHome = (launch.env as Record<string, string> | undefined)?.GROK_HOME
      argv[2] += `\n(deny file-write* (subpath ${JSON.stringify(join(homedir(), '.grok'))})${grokHome ? ` (literal ${JSON.stringify(join(grokHome, 'auth.json'))})` : ''})\n`
    }
    return {
      argv,
      env,
      ...('activate' in launch && launch.activate ? { activate: launch.activate } : {}),
      cleanup: async () => {
        try {
          if ('cleanup' in launch && launch.cleanup) await launch.cleanup()
          sealPrivateTree(state)
        } finally {
          if (temporary) rmSync(temporary, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    if ('cleanup' in launch && launch.cleanup) await launch.cleanup()
    if (temporary) rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}
export async function extendedCatalog(
  cli: CliId,
  executable: string,
  capture: (argv: string[], env?: Record<string, string>) => Promise<string>,
  stateDirectory: string,
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  signal?.throwIfAborted()
  const catalogRoot = privateDirectory(join(stateDirectory, 'catalog', cli))
  const state = privateDirectory(mkdtempSync(join(catalogRoot, 'query-')))
  type Scope = { leaseDirectory?: string }
  const run = async (
    argv: string[],
    env?: Record<string, string>,
    phaseOrScope?: PiOmpMetadataPhase | Scope,
    scope?: Scope,
  ) => {
    const phase = typeof phaseOrScope === 'string' ? phaseOrScope : undefined
    const sandboxScope = typeof phaseOrScope === 'object' ? phaseOrScope : scope
    const temporary = cli === 'zcode' ? mkdtempSync('/private/tmp/cwn-') : undefined
    if (temporary) chmodSync(temporary, 0o700)
    try {
      const confined =
        cli === 'hermes'
          ? hermesSandbox(
              privateArgv(argv),
              state,
              state,
              'plan',
              effectiveHermesHome({ ...config, stateDirectory: config.stateDirectory ?? stateDirectory }),
              hermesCommandInstallationHome(argv) ?? hermesHomeDirectory(config.hermesHome),
            )
          : confineExtended(
              privateArgv(argv),
              state,
              state,
              'plan',
              temporary,
              cli === 'opencode' ? openCodeAuthDirectory(config.stateDirectory ?? stateDirectory) : undefined,
              cli === 'pi' || cli === 'omp',
              sandboxScope?.leaseDirectory,
            )
      // Exactly one outer sandbox owns each phase. Only the SDK/native directory
      // phase is offline; the account phase performs bounded metadata GETs.
      if (phase === 'native-candidates') confined[2] += '\n(deny network*)\n'
      return await capture(confined, {
        ...env,
        ...(temporary ? { TMPDIR: temporary } : {}),
        ELECTRON_RUN_AS_NODE: '1',
      })
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true })
    }
  }
  const models =
    cli === 'zcode'
      ? await discoverZCode(
          executable,
          run,
          state,
          zcodeAuthDirectory(config.zcodeAuthDirectory, config.stateDirectory ?? stateDirectory),
          config.zcodeBuiltinConfig,
          { signal },
        )
      : cli === 'pi' || cli === 'omp'
        ? await discoverPiOmp(cli, executable, run, state, {
            accountRoot: config.stateDirectory ?? stateDirectory,
            signal,
          })
        : cli === 'opencode'
          ? await discoverOpenCode(
              executable,
              run,
              state,
              openCodeAuthDirectory(config.stateDirectory ?? stateDirectory),
              false,
              { signal },
            )
          : cli === 'hermes'
            ? await discoverHermes(
                executable,
                run,
                state,
                effectiveHermesHome({ ...config, stateDirectory: config.stateDirectory ?? stateDirectory }),
                { signal },
              )
            : cli === 'grok'
              ? await discoverGrok(executable, run, state, { signal })
              : undefined
  if (!models) throw new Error('未知 CLI')
  signal?.throwIfAborted()
  // A successful capture has confirmed that its process range exited. On a
  // rejected capture preserve the query directory without touching live files.
  sealPrivateTree(state)
  return models
}
