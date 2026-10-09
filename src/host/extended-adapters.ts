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
import { homedir, tmpdir } from 'node:os'
import type { CliId, Preference, TaskMode, ModelChoice } from '../shared/types.ts'
import type { RuntimeConfig } from './process.ts'
import { prepareZCode, discoverZCode, zcodeAuthDirectory } from './zcode-adapter.ts'
import {
  preparePiOmp,
  discoverPiOmp,
  type PiOmpMetadataCapture,
} from './pi-omp-adapter.ts'
import { prepareOpenCode, discoverOpenCode, openCodeAuthDirectory } from './opencode-adapter.ts'
import { prepareHermes, discoverHermes } from './hermes-adapter.ts'
import { effectiveHermesHome } from './hermes-account-context.ts'
import { prepareGrok, discoverGrok } from './grok-adapter.ts'

export const EXTENDED_CLIS = ['zcode', 'grok', 'omp', 'pi', 'hermes', 'opencode'] as const
export const isExtendedCli = (cli: string): cli is (typeof EXTENDED_CLIS)[number] =>
  (EXTENDED_CLIS as readonly string[]).includes(cli)
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
    if (info.isDirectory() && process.platform === 'win32') {
      // Windows does not support opening directories with POSIX O_DIRECTORY.
      // Keep the same location/inode checks without widening to linked targets.
      const canonical = realpathSync(path)
      ancestors.push({ path, info })
      try {
        assertLocations()
        if (realpathSync(path) !== canonical)
          throw new Error('CLI private state changed during permission cleanup')
        chmodSync(path, 0o700)
        for (const entry of readdirSync(path)) visit(join(path, entry))
        assertLocations()
        if (realpathSync(path) !== canonical)
          throw new Error('CLI private state changed during permission cleanup')
      } finally {
        ancestors.pop()
      }
      return
    }
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
    ((argv, env, phase, scope) =>
      metadataCapture(privateArgv(argv), { ...env, ELECTRON_RUN_AS_NODE: '1' }, phase, scope))
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
  const temporary = cli === 'zcode' ? mkdtempSync(join(tmpdir(), 'cwn-')) : undefined
  if (temporary) chmodSync(temporary, 0o700)
  const env = {
    ...launch.env,
    ...(temporary ? { TMPDIR: temporary, TMP: temporary, TEMP: temporary } : {}),
    ELECTRON_RUN_AS_NODE: '1',
  }
  try {
    const argv = privateArgv(launch.argv)
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
  const run = async (argv: string[], env?: Record<string, string>) => {
    const temporary = cli === 'zcode' ? mkdtempSync(join(tmpdir(), 'cwn-')) : undefined
    if (temporary) chmodSync(temporary, 0o700)
    try {
      return await capture(privateArgv(argv), {
        ...env,
        ...(temporary ? { TMPDIR: temporary, TMP: temporary, TEMP: temporary } : {}),
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
