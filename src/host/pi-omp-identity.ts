import { mkdtemp, rm, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectPiInstallation } from './pi-installation.mjs'
import { ProcessCleanupUnconfirmedError } from './process.ts'

const mismatch = (message: string) => Object.assign(new Error(message), { code: 'CLI_IDENTITY_MISMATCH' })

// This is installation capability evidence, never account or model evidence.
// Only standalone native binaries qualify: script dependencies may change
// without changing the launcher's own metadata.
const ompCapabilities = new Map<string, string>()
async function binaryRevision(executable: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const path = await realpath(executable)
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) return undefined
    const magic = Buffer.alloc(4)
    if ((await handle.read(magic, 0, 4, 0)).bytesRead !== 4) return undefined
    if (
      ![
        '7f454c46',
        'cffaedfe',
        'cefaedfe',
        'feedfacf',
        'feedface',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca',
      ].includes(magic.toString('hex'))
    )
      return undefined
    return {
      path,
      revision: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
    }
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

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
  const before = await binaryRevision(executable)
  if (before && ompCapabilities.get(before.path) === before.revision) return executable
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
    if (before) {
      const after = await binaryRevision(executable)
      if (after?.path === before.path && after.revision === before.revision) {
        ompCapabilities.delete(before.path)
        ompCapabilities.set(before.path, before.revision)
        if (ompCapabilities.size > 64) ompCapabilities.delete(ompCapabilities.keys().next().value!)
      }
    }
    return executable
  } catch (error) {
    if (error instanceof ProcessCleanupUnconfirmedError) cleanupConfirmed = false
    throw error
  } finally {
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true })
  }
}
