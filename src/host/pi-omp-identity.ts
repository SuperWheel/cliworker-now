import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectPiInstallation } from './pi-installation.mjs'
import { ProcessCleanupUnconfirmedError } from './process.ts'

const mismatch = (message: string) => Object.assign(new Error(message), { code: 'CLI_IDENTITY_MISMATCH' })

/** Runs only bounded --help metadata, never login, OAuth refresh or a model prompt. */
export async function verifyPiOmpExecutable(
  cli: 'pi' | 'omp',
  executable: string,
  capture: (argv: string[], cwd: string, env: Record<string, string>) => Promise<string>,
): Promise<string> {
  if (cli === 'pi') return inspectPiInstallation(executable).executable
  let isPi = false
  try {
    inspectPiInstallation(executable)
    isPi = true
  } catch {
    // A standalone OMP binary has no Pi manifest; its native help must identify it.
  }
  if (isPi) throw mismatch('OMP 入口指向 Pi Coding Agent；二者是独立 CLI，请修正 OMP 程序路径')
  const root = await mkdtemp(join(tmpdir(), 'cliworker-omp-identity-'))
  let cleanupConfirmed = true
  try {
    const argv = /\.[cm]?js$/.test(executable)
      ? [process.execPath, executable, '--help']
      : [executable, '--help']
    const help = await capture(argv, root, {
      PI_CODING_AGENT_DIR: root,
      PI_CONFIG_DIR: root,
      OMP_PROFILE: '',
      PI_PROFILE: '',
      TMPDIR: root,
      ELECTRON_RUN_AS_NODE: '1',
    })
    if (
      !/^omp v\d+\.\d+\.\d+\b/m.test(help) ||
      !/\brpc\b/.test(help) ||
      !/^\s+setup\s/m.test(help) ||
      !/^\s+models\s/m.test(help) ||
      [
        '--mode',
        '--config',
        '--thinking',
        '--session-dir',
        '--tools',
        '--no-rules',
        '--no-title',
        '--no-lsp',
        '--no-pty',
        '--approval-mode',
      ].some((flag) => !help.includes(flag))
    )
      throw mismatch(
        'OMP 安装身份或原生接口不匹配；需要支持 RPC、models 和 setup 的 Oh My Pi，不能使用 Pi 入口',
      )
    return executable
  } catch (error) {
    if (error instanceof ProcessCleanupUnconfirmedError) cleanupConfirmed = false
    throw error
  } finally {
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true })
  }
}
