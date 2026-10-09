import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPiOmpLogoutSources, safePiOmpAncestors } from './pi-omp-native.ts'
import { projectDirectory } from './process.ts'
import { ompConfigurationEnvironment } from './pi-omp-environment.mjs'
import type { PiOmpAccountTerminalInput, PiOmpAccountTerminalLaunch } from './pi-omp-accounts.ts'

/** No snapshot, migration or credential deletion here: only native user-operated menus. */
export async function preparePiOmpLogout(
  input: PiOmpAccountTerminalInput,
): Promise<PiOmpAccountTerminalLaunch> {
  const { cli, signal } = input
  signal?.throwIfAborted()
  projectDirectory(input.project)
  const sources = await readPiOmpLogoutSources(
    cli,
    input.stateDirectory,
    signal ?? new AbortController().signal,
    { nativeHome: input.nativeHome },
  )
  const source = input.source
    ? sources.find((item) => item.id === input.source)
    : sources.length === 1
      ? sources[0]
      : undefined
  if (!source)
    throw new Error(
      sources.length > 1 && !input.source ? '请选择要退出的账号来源' : '账号来源已变化，请刷新后重试',
    )
  const directory = await realpath(source.directory)
  await safePiOmpAncestors(directory)
  signal?.throwIfAborted()
  const parent = join(resolve(input.stateDirectory), 'account-runtime')
  await safePiOmpAncestors(parent)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentIdentity = await lstat(parent)
  const runtime = await mkdtemp(join(parent, `${cli}-logout-`))
  const identity = await lstat(runtime)
  let removed = false
  const cleanup = async () => {
    if (removed) return
    const currentParent = await lstat(parent)
    if (
      currentParent.isSymbolicLink() ||
      currentParent.dev !== parentIdentity.dev ||
      currentParent.ino !== parentIdentity.ino
    )
      throw new Error('Account runtime parent changed before cleanup')
    try {
      const current = await lstat(runtime)
      if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino)
        throw new Error('Account runtime changed before cleanup')
      await rm(runtime, { recursive: true, force: true })
      removed = true
    } catch (error: any) {
      if (error.code === 'ENOENT') removed = true
      else throw error
    }
  }
  try {
    const agent = join(runtime, 'agent'),
      temporary = join(runtime, 'tmp')
    for (const path of [agent, temporary, join(runtime, 'sessions'), join(runtime, 'logs')])
      await mkdir(path, { mode: 0o700 })
    const env: Record<string, string> = {
      ...source.env,
      PI_CODING_AGENT_DIR: agent,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      ELECTRON_RUN_AS_NODE: '1',
      OMP_AUTH_BROKER_URL: '',
      OMP_AUTH_BROKER_TOKEN: '',
      OMP_PROFILE: '',
      PI_PROFILE: '',
    }
    let native: string[]
    if (cli === 'pi') {
      const auth = source.stored ? join(directory, 'auth.json') : join(agent, 'auth.json')
      if (!source.stored) await writeFile(auth, '{}', { flag: 'wx', mode: 0o600 })
      native = [
        process.execPath,
        fileURLToPath(new URL('./pi-login.mjs', import.meta.url)),
        input.executable,
        'logout',
        auth,
      ]
      env.PI_OFFLINE = '1'
      env.PI_TELEMETRY = '0'
    } else {
      // Operate on the selected real DB, never a copied DB/WAL. Windows uses the
      // native agent root directly without requiring symlink privileges.
      if (source.stored) {
        if (process.platform === 'win32') {
          if (source.brokerConfigured)
            throw new Error('请先在 OMP 自身配置中停用账号代理，再退出该来源')
          env.PI_CODING_AGENT_DIR = directory
        } else {
          await symlink(join(directory, 'agent.db'), join(agent, 'agent.db'))
        }
      }
      await writeFile(
        join(agent, 'config.yml'),
        JSON.stringify({
          ...source.config,
          auth: { ...(source.config.auth ?? {}), broker: undefined },
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
        }),
        { mode: 0o600 },
      )
      Object.assign(env, ompConfigurationEnvironment(runtime))
      native = [
        input.executable,
        '--no-session',
        '--no-tools',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-title',
        '--no-lsp',
        '--no-pty',
        '--approval-mode',
        'always-ask',
        '--session-dir',
        join(runtime, 'sessions'),
        '--config',
        join(agent, 'config.yml'),
      ]
    }
    signal?.throwIfAborted()
    const argv = [process.execPath, fileURLToPath(new URL('./private-launch.mjs', import.meta.url)), ...native]
    return {
      argv,
      cwd: runtime,
      env,
      cleanup,
      instruction: `${source.label}：${cli === 'pi' ? '选择要退出的服务商。' : '输入 /logout，选择服务商和凭据。'}其他来源保留；.env 或模型配置中的 API 请在原配置中管理。`,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
