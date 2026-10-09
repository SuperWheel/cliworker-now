import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const OWN_ACCOUNT_BUSY = '账号正被使用，请稍后刷新'
const nonceValid = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
async function privateRoot(root) {
  const info = await lstat(root)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.mode & 0o077)) ||
    (await realpath(root)) !== resolve(root)
  )
    throw new Error('账号运行目录无法安全使用')
}
/** A lease is not stolen after PID death: its descendants may still be alive.
 * Only Host cleanup after confirmed process-range exit may release it. */
export async function assertOwnAccountLeaseIdle(root) {
  await privateRoot(root)
  try {
    await lstat(join(root, '.lease'))
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(OWN_ACCOUNT_BUSY)
}
export async function acquireOwnAccountLease(root, nonce) {
  if (!nonceValid(nonce)) throw new Error('Invalid account lease')
  await privateRoot(root)
  const lock = join(root, '.lease')
  const pending = join(root, `.lease-${nonce}.pending`)
  await assertOwnAccountLeaseIdle(root)
  await mkdir(pending, { mode: 0o700 })
  try {
    await writeFile(join(pending, 'owner.json'), JSON.stringify({ nonce, pid: process.pid }), {
      flag: 'wx',
      mode: 0o600,
    })
    // Publish a complete, nonempty owner directory in one filesystem operation.
    // A killed initializer leaves only its nonce-specific pending directory.
    await rename(pending, lock)
  } catch (error) {
    await rm(pending, { recursive: true, force: true })
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') throw new Error(OWN_ACCOUNT_BUSY)
    throw error
  }
}
export async function ownsOwnAccountLease(root, nonce) {
  if (!nonceValid(nonce)) throw new Error('Invalid account lease')
  await privateRoot(root)
  let handle
  try {
    const lock = await lstat(join(root, '.lease'))
    if (!lock.isDirectory() || lock.isSymbolicLink() || (process.platform !== 'win32' && (lock.mode & 0o077)))
      throw new Error('账号使用状态无法确认')
    handle = await open(
      join(root, '.lease/owner.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077)) || info.size > 1024)
      throw new Error('账号使用状态无法确认')
    return JSON.parse(await handle.readFile('utf8')).nonce === nonce
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  } finally {
    await handle?.close()
  }
}
export async function releaseOwnAccountLease(root, nonce) {
  if (!nonceValid(nonce)) throw new Error('Invalid account lease')
  await privateRoot(root)
  // Safe only at this API's contract boundary: Host confirmed this nonce's whole
  // process range exited, including an initializer killed before publication.
  await rm(join(root, `.lease-${nonce}.pending`), { recursive: true, force: true })
  const lock = join(root, '.lease')
  let handle
  try {
    const directory = await lstat(lock)
    if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' && (directory.mode & 0o077)))
      throw new Error('账号使用状态无法安全清理')
    handle = await open(
      join(lock, 'owner.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077)) || info.size > 1024)
      throw new Error('账号使用状态无法安全清理')
    const owner = JSON.parse(await handle.readFile('utf8'))
    if (owner.nonce !== nonce) return
    const current = await lstat(lock)
    if (current.dev !== directory.dev || current.ino !== directory.ino || current.isSymbolicLink())
      throw new Error('账号使用状态在清理前改变')
    await handle.close()
    handle = undefined
    await rm(lock, { recursive: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  } finally {
    await handle?.close()
  }
}
