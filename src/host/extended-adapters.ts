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
import { preparePiOmp, discoverPiOmp, type PiOmpMetadataCapture } from './pi-omp-adapter.ts'
import {
  prepareOpenCode,
  discoverOpenCode,
  openCodeAuthDirectory,
  openCodeCredentialEnvironment,
} from './opencode-adapter.ts'
import { prepareHermes, discoverHermes, hermesHomeDirectory } from './hermes-adapter.ts'
import { hermesSandbox } from './hermes-sandbox.ts'
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
  selectedModel?: string,
): Promise<Record<string, string>> {
  if (cli === 'opencode')
    return selectedModel && !selectedModel.startsWith('zhipuai-coding-plan/')
      ? {}
      : openCodeCredentialEnvironment(config)
  if (!['pi', 'omp'].includes(cli) || !config.zaiCredentialRef) return {}
  const provider = selectedModel?.slice(0, selectedModel.indexOf('/'))
  if (provider && !['zai-coding-cn', 'cliworker-zai-cn', 'zhipu-coding-plan'].includes(provider)) return {}
  let key: string | undefined
  try {
    key = await config.resolveCredential?.(config.zaiCredentialRef)
  } catch {
    throw new Error('Pi/OMP 的 Harness 智谱凭据引用不可用，请检查原生模型设置')
  }
  if (!key) throw new Error('Pi/OMP 的 Harness 智谱凭据引用不可用，请检查原生模型设置')
  return { ZAI_CODING_CN_API_KEY: key }
}
/** The new adapters need writable private state even for a read-only project. */
export function confineExtended(
  argv: string[],
  state: string,
  project: string,
  mode: TaskMode,
  temporary?: string,
  authDirectory?: string,
): string[] {
  if (process.platform !== 'darwin') throw new Error('这些新增 CLI 当前仅验收 macOS 沙箱；本平台暂不能运行')
  const roots = [
    realpathSync(state),
    ...(authDirectory ? [realpathSync(authDirectory)] : []),
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
  metadataCapture?: PiOmpMetadataCapture,
) {
  const state = privateDirectory(stateDirectory)
  const input = { executable, project, preference, mode, prompt, conversationId, stateDirectory: state }
  const creds = await credentialEnvironment(cli, config, preference.model)
  const metadata: PiOmpMetadataCapture | undefined =
    metadataCapture &&
    (async (argv, env, phase) => {
      const confined = confineExtended(privateArgv(argv), state, state, 'plan')
      if (phase === 'native-candidates') confined[2] += '\n(deny network*)\n'
      return metadataCapture(confined, { ...env, ...creds, ELECTRON_RUN_AS_NODE: '1' }, phase)
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
              managedCredentials: !!config.zaiCredentialRef,
            },
            metadata,
          )
        : cli === 'opencode'
          ? await prepareOpenCode({
              ...input,
              authDirectory: openCodeAuthDirectory(config.stateDirectory),
              managedCredentials:
                !!config.zaiCredentialRef && preference.model.startsWith('zhipuai-coding-plan/'),
            })
          : cli === 'hermes'
            ? await prepareHermes({ ...input, hermesHome: config.hermesHome })
            : cli === 'grok'
              ? await prepareGrok(input)
              : undefined
  if (!launch) throw new Error('未知 CLI')
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
        cli === 'hermes'
          ? hermesSandbox(
              privateArgv(launch.argv),
              state,
              project,
              mode,
              hermesHomeDirectory(config.hermesHome),
            )
          : confineExtended(
              privateArgv(launch.argv),
              state,
              project,
              mode,
              temporary,
              cli === 'opencode' ? openCodeAuthDirectory(config.stateDirectory) : undefined,
            ),
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
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  signal?.throwIfAborted()
  const catalogRoot = privateDirectory(join(stateDirectory, 'catalog', cli))
  const state = privateDirectory(mkdtempSync(join(catalogRoot, 'query-')))
  const creds = await credentialEnvironment(cli, config)
  const run: PiOmpMetadataCapture = async (argv, env, phase) => {
    const temporary = cli === 'zcode' ? mkdtempSync('/private/tmp/cwn-') : undefined
    if (temporary) chmodSync(temporary, 0o700)
    try {
      const confined =
        cli === 'hermes'
          ? hermesSandbox(privateArgv(argv), state, state, 'plan', hermesHomeDirectory(config.hermesHome))
          : confineExtended(
              privateArgv(argv),
              state,
              state,
              'plan',
              temporary,
              cli === 'opencode' ? openCodeAuthDirectory(config.stateDirectory ?? stateDirectory) : undefined,
            )
      // Exactly one outer sandbox owns each phase. Only the SDK/native directory
      // phase is offline; the account phase performs bounded metadata GETs.
      if (phase === 'native-candidates') confined[2] += '\n(deny network*)\n'
      return await capture(confined, {
        ...env,
        ...creds,
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
        )
      : cli === 'pi' || cli === 'omp'
        ? await discoverPiOmp(cli, executable, run, state, {
            accountRoot: config.stateDirectory ?? stateDirectory,
            managedCredentials: !!config.zaiCredentialRef,
          })
        : cli === 'opencode'
          ? await discoverOpenCode(
              executable,
              run,
              state,
              openCodeAuthDirectory(config.stateDirectory ?? stateDirectory),
              !!config.zaiCredentialRef,
              { credentialEnv: creds, signal },
            )
          : cli === 'hermes'
            ? await discoverHermes(executable, run, state, config.hermesHome)
            : cli === 'grok'
              ? await discoverGrok(executable, run, state)
              : undefined
  if (!models) throw new Error('未知 CLI')
  signal?.throwIfAborted()
  // A successful capture has confirmed that its process range exited. On a
  // rejected capture preserve the query directory without touching live files.
  sealPrivateTree(state)
  return models
}
