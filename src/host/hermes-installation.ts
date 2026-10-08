import { constants } from 'node:fs'
import { access, open, realpath } from 'node:fs/promises'

export class HermesExecutableError extends Error {}

/** Inspect the installed fixed exec shim without invoking its installer or auth UI. */
export async function verifyHermesExecutable(executable: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
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
