import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash, createDecipheriv } from 'node:crypto'
import { homedir, platform, userInfo } from 'node:os'
import { join } from 'node:path'

/** Native standalone-account-provider-runtime.js identity binding (ZCode 0.16.9).
 * Keys remain in the Host and are used only for the corresponding native route.
 * OAuth access/refresh tokens and old identities are deliberately not fallbacks.
 */
export async function readZCodeAccountApiKeys(
  authDirectory: string,
  providerIds: string[],
  options: { signal?: AbortSignal; credentialSecret?: string } = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (!providerIds.length) return result
  options.signal?.throwIfAborted()
  let file: Awaited<ReturnType<typeof open>> | undefined
  const buffer = Buffer.alloc(64 * 1024 + 1)
  let key: Buffer | undefined
  try {
    for (const directory of [
      authDirectory,
      join(authDirectory, '.zcode'),
      join(authDirectory, '.zcode/v2'),
    ]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe ZCode credential directory')
    }
    file = await open(
      join(authDirectory, '.zcode/v2/credentials.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 || !info.size)
      throw new Error('Unsafe ZCode credential file')
    let length = 0
    while (length < buffer.length) {
      options.signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await file.stat()
    if (
      length > 64 * 1024 ||
      length !== info.size ||
      info.size !== after.size ||
      info.mtimeMs !== after.mtimeMs
    )
      throw new Error('ZCode credentials changed during read')
    const raw: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid ZCode credentials')
    const values = raw as Record<string, unknown>
    let username = 'unknown'
    try {
      username = userInfo().username
    } catch {
      /* native fallback */
    }
    const secret =
      (options.credentialSecret ?? process.env.ZCODE_CREDENTIAL_SECRET?.trim()) ||
      `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
    key = createHash('sha256').update(secret).digest()
    const decode = (id: string): string | undefined => {
      const value = values[id]
      if (value == null) return
      if (typeof value !== 'string') throw new Error('Invalid ZCode credential value')
      if (!value.startsWith('enc:v1:')) return value.trim() || undefined
      const parts = value.slice(7).split('.')
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
        throw new Error('Invalid ZCode cipher')
      const [iv, tag, body] = parts.map((part) => Buffer.from(part, 'base64url'))
      if (iv!.length !== 12 || tag!.length !== 16) throw new Error('Invalid ZCode cipher')
      const cipher = createDecipheriv('aes-256-gcm', key!, iv!)
      cipher.setAuthTag(tag!)
      const plain = Buffer.concat([cipher.update(body!), cipher.final()])
      try {
        return plain.toString('utf8').trim() || undefined
      } finally {
        plain.fill(0)
      }
    }
    for (const providerId of new Set(providerIds)) {
      options.signal?.throwIfAborted()
      const identity = decode(`account-provider:${providerId}:identity`)
      if (!identity) continue
      const apiKey = decode(
        `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`,
      )
      if (apiKey) result.set(providerId, apiKey)
    }
    return result
  } catch (error) {
    options.signal?.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw new Error('无法安全读取 ZCode 当前账号的 Worker 凭据，请在原生登录设置中检查')
  } finally {
    key?.fill(0)
    buffer.fill(0)
    await file?.close()
  }
}
