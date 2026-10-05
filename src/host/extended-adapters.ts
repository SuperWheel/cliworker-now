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
import type { CliId, Preference, TaskMode, ModelChoice } from '../shared/types.ts'
import type { RuntimeConfig } from './process.ts'
import { prepareZCode, discoverZCode } from './zcode-adapter.ts'
import { preparePiOmp, discoverPiOmp } from './pi-omp-adapter.ts'
import { prepareOpenCode, discoverOpenCode } from './opencode-adapter.ts'
import { prepareHarness, discoverHarness } from './harness-adapter.ts'
import { prepareGrok, discoverGrok } from './grok-adapter.ts'

export const EXTENDED_CLIS = ['zcode', 'grok', 'omp', 'pi', 'harness', 'opencode'] as const
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
export async function credentialEnvironment(
  cli: CliId,
  config: RuntimeConfig,
): Promise<Record<string, string>> {
  if (!['pi', 'omp', 'opencode', 'harness'].includes(cli) || !config.zaiCredentialRef) return {}
  const key = await config.resolveCredential?.(config.zaiCredentialRef)
  if (!key) return {}
  return cli === 'opencode' ? { ZHIPU_API_KEY: key } : { ZAI_CODING_CN_API_KEY: key }
}
/** The new adapters need writable private state even for a read-only project. */
export function confineExtended(
  argv: string[],
  state: string,
  project: string,
  mode: TaskMode,
  temporary?: string,
): string[] {
  if (process.platform !== 'darwin') throw new Error('这些新增 CLI 当前仅验收 macOS 沙箱；本平台暂不能运行')
  const roots = [
    realpathSync(state),
    ...(temporary ? [realpathSync(temporary)] : []),
    ...(mode === 'accept-edits' ? [realpathSync(project)] : []),
  ]
  const policy = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* ${roots.map((r) => `(subpath ${JSON.stringify(r)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))\n`
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
) {
  const state = privateDirectory(stateDirectory)
  const input = { executable, project, preference, mode, prompt, conversationId, stateDirectory: state }
  const launch =
    cli === 'zcode'
      ? await prepareZCode({
          ...input,
          authDirectory: config.zcodeAuthDirectory,
          builtinConfig: config.zcodeBuiltinConfig,
        })
      : cli === 'pi' || cli === 'omp'
        ? await preparePiOmp({ ...input, cli })
        : cli === 'opencode'
          ? await prepareOpenCode(input)
          : cli === 'harness'
            ? await prepareHarness(input)
            : cli === 'grok'
              ? await prepareGrok(input)
              : undefined
  if (!launch) throw new Error('未知 CLI')
  // Harness file tools and bash enforce its own read-only/workspace-write policy.
  // An additional Seatbelt wrapper prevents its native sandbox from starting.
  const creds = await credentialEnvironment(cli, config)
  const temporary = cli === 'zcode' ? mkdtempSync('/private/tmp/cwn-') : undefined
  if (temporary) chmodSync(temporary, 0o700)
  const env = {
    ...launch.env,
    ...creds,
    ...(temporary ? { TMPDIR: temporary } : {}),
    ELECTRON_RUN_AS_NODE: '1',
  }
  try {
    return {
      argv:
        cli === 'harness'
          ? privateArgv(launch.argv)
          : confineExtended(privateArgv(launch.argv), state, project, mode, temporary),
      env,
      cleanup: () => {
        try {
          sealPrivateTree(state)
        } finally {
          if (temporary) rmSync(temporary, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
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
): Promise<ModelChoice[]> {
  const catalogRoot = privateDirectory(join(stateDirectory, 'catalog', cli))
  const state = privateDirectory(mkdtempSync(join(catalogRoot, 'query-')))
  const creds = await credentialEnvironment(cli, config)
  const run = async (argv: string[], env?: Record<string, string>) => {
    const temporary = cli === 'zcode' ? mkdtempSync('/private/tmp/cwn-') : undefined
    if (temporary) chmodSync(temporary, 0o700)
    try {
      return await capture(
        cli === 'harness'
          ? privateArgv(argv)
          : confineExtended(privateArgv(argv), state, state, 'plan', temporary),
        { ...env, ...creds, ...(temporary ? { TMPDIR: temporary } : {}), ELECTRON_RUN_AS_NODE: '1' },
      )
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true })
    }
  }
  const models =
    cli === 'zcode'
      ? await discoverZCode(executable, run, state, config.zcodeAuthDirectory, config.zcodeBuiltinConfig)
      : cli === 'pi' || cli === 'omp'
        ? await discoverPiOmp(cli, executable, run, state)
        : cli === 'opencode'
          ? await discoverOpenCode(executable, run, state)
          : cli === 'harness'
            ? await discoverHarness(executable, run, state)
            : cli === 'grok'
              ? await discoverGrok(executable, run, state)
              : undefined
  if (!models) throw new Error('未知 CLI')
  // A successful capture has confirmed that its process range exited. On a
  // rejected capture preserve the query directory without touching live files.
  sealPrivateTree(state)
  return models
}
