import { constants } from 'node:fs'
import { access, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeLaunchArgv } from './native-launch.mjs'

export class HermesExecutableError extends Error {}

export function hermesCommandInstallationHome(argv: string[]): string | undefined {
  return argv[2] === fileURLToPath(new URL('./hermes-native-entry.py', import.meta.url)) && argv[4]
    ? dirname(dirname(dirname(argv[4])))
    : undefined
}

/** Reuse the current official checkout's committed dependency environment, not a
 * directory selected by recency/hash guessing. A clean account home must not run
 * the installer's borrowed-home sync. Older/self-contained entries retain their
 * native launcher contract. The child rechecks this selection under its native lock. */
export async function hermesNativeCommand(
  executable: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  // The official Windows distlib exe selects the recorded store Python itself.
  // Its fixed fallback cmd is decoded as data, never interpreted by cmd.exe.
  // Keep bootstrap and update/lease behavior owned by the installed CLI.
  if (process.platform === 'win32') {
    signal?.throwIfAborted()
    const command = nativeLaunchArgv([executable, ...args])
    await access(command[0]!, constants.R_OK)
    return command
  }
  let current = executable
  const read = async (path: string, limit: number) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > limit)
        throw new Error('Unsafe Hermes installation record')
      const result = await file.readFile('utf8')
      if (Buffer.byteLength(result) > limit) throw new Error('Oversized Hermes installation record')
      signal?.throwIfAborted()
      return result
    } finally {
      await file.close()
    }
  }
  for (let depth = 0; depth < 4; depth++) {
    signal?.throwIfAborted()
    let path: string, source: string
    try {
      path = await realpath(current)
      source = await read(path, 128 * 1024)
    } catch (error) {
      signal?.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [executable, ...args]
      throw new HermesExecutableError('启动入口不可用，请修复安装')
    }
    const shim =
      /^#![^\r\n]*\b(?:sh|bash|zsh)\s*\r?\n\s*exec\s+(?:"(\/[^"\r\n$`]+)"|(\/[^\s$`"'\\;|&<>]+))\s+"\$@"\s*$/.exec(
        source,
      )
    if (shim) {
      current = shim[1] ?? shim[2]!
      continue
    }
    if (!path.endsWith(`${sep}.hermes${sep}bin${sep}hermes`) || !source.includes('hermes_bootstrap'))
      return [executable, ...args]
    const checkout = dirname(dirname(dirname(path)))
    if (!source.includes(checkout)) throw new HermesExecutableError('Hermes 安装入口与源码不匹配')
    const owner = dirname(checkout),
      key = createHash('sha256').update(checkout).digest('hex').slice(0, 16)
    const install = join(owner, 'installs', key),
      facts = join(install, 'facts.json')
    try {
      const data = JSON.parse(await read(facts, 4 * 1024 * 1024))
      const environment = data?.packages?.venv?.environment
      if (
        typeof environment !== 'string' ||
        !environment.startsWith(join(install, 'environments') + sep) ||
        (await realpath(environment)) !== environment
      )
        throw new Error('Invalid Hermes dependency selection')
      await read(join(environment, 'pyvenv.cfg'), 64 * 1024)
      await access(join(environment, 'bin/python'), constants.X_OK)
      for (const file of ['hermes_bootstrap.py', 'hermes_cli/main.py', 'pm/environments.py'])
        await access(join(checkout, file), constants.R_OK)
      return [
        join(environment, 'bin/python'),
        '-I',
        fileURLToPath(new URL('./hermes-native-entry.py', import.meta.url)),
        checkout,
        facts,
        environment,
        ...args,
      ]
    } catch {
      signal?.throwIfAborted()
      throw new HermesExecutableError('Hermes 当前安装依赖不可用，请在原生终端修复安装')
    }
  }
  throw new HermesExecutableError('启动脚本异常，请修复安装')
}

/** Inspect the installed fixed exec shim without invoking its installer or auth UI. */
export async function verifyHermesExecutable(executable: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (process.platform === 'win32') {
    try {
      const command = nativeLaunchArgv([executable])
      await access(command[0]!, constants.R_OK)
      if (
        !(await open(command[0]!, 'r').then(async (file) => {
          try {
            return (await file.stat()).isFile()
          } finally {
            await file.close()
          }
        }))
      )
        throw new Error('Invalid Hermes entry')
      signal.throwIfAborted()
      return
    } catch {
      signal.throwIfAborted()
      throw new HermesExecutableError('启动入口不可用，请修复安装')
    }
  }
  let current = executable
  for (let depth = 0; depth < 4; depth++) {
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      await access(current, constants.X_OK)
      // Official per-user launchers may themselves be symbolic links.
      file = await open(
        await realpath(current),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const info = await file.stat()
      if (!info.isFile()) throw new Error('Invalid Hermes entry')
      if (info.size > 16 * 1024) return
      const bytes = Buffer.alloc(16 * 1024 + 1)
      let source: string
      try {
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        const after = await file.stat()
        if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
          throw new Error('Hermes entry changed during inspection')
        source = bytes.subarray(0, bytesRead).toString('utf8')
      } finally {
        bytes.fill(0)
      }
      signal.throwIfAborted()
      const shim =
        /^#![^\r\n]*\b(?:sh|bash|zsh)\s*\r?\n\s*exec\s+(?:"(\/[^"\r\n$`]+)"|(\/[^\s$`"'\\;|&<>]+))\s+"\$@"\s*$/.exec(
          source,
        )
      if (!shim) return
      current = shim[1] ?? shim[2]!
    } catch {
      signal.throwIfAborted()
      throw new HermesExecutableError('启动入口不可用，请修复安装')
    } finally {
      await file?.close()
    }
  }
  throw new HermesExecutableError('启动脚本异常，请修复安装')
}
