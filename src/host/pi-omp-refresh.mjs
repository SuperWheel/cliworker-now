import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { inspectPiInstallation } from './pi-installation.mjs'
import { ownsOwnAccountLease, releaseOwnAccountLease } from './own-account-lease.mjs'

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const stable = (value) =>
  JSON.stringify(
    object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, JSON.parse(stable(value[key]))]),
        )
      : Array.isArray(value)
        ? value.map((entry) => JSON.parse(stable(entry)))
        : (value ?? null),
  )
export const refreshFingerprint = (value) => createHash('sha256').update(stable(value)).digest('hex')
const changed = () => new Error('账号配置已变化，请重新刷新模型')
const unsafe = () => new Error('无法安全保存账号续期，请重新登录')
function claims(value) {
  try {
    if (typeof value !== 'string' || value.length > 65536) return {}
    const parsed = JSON.parse(Buffer.from(value.split('.')[1] ?? '', 'base64url').toString('utf8'))
    return object(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
/** Identity comparison only, never a remote authentication assertion. */
export function refreshPrincipal(value) {
  if (!object(value) || value.type !== 'oauth') return undefined
  const identity = claims(value.id_token ?? value.idToken)
  const token = claims(value.access ?? value.access_token)
  const account =
    value.accountId ?? value.account_id ?? token['https://api.openai.com/auth']?.chatgpt_account_id
  const subject = identity.sub ?? token.sub ?? value.userId ?? value.user_id
  const email = identity.email ?? value.email
  const text = (item) => typeof item === 'string' && !!item
  if (!text(account) && !text(subject) && !text(email)) return undefined
  return refreshFingerprint({
    ...(text(account) ? { accountId: account } : {}),
    ...(text(subject) ? { subject } : text(email) ? { email: email.toLowerCase() } : {}),
    ...(text(identity.iss ?? token.iss) ? { issuer: identity.iss ?? token.iss } : {}),
    ...(text(value.organizationId ?? value.organization_id)
      ? { organization: value.organizationId ?? value.organization_id }
      : {}),
  })
}
export async function refreshJson(path, privateFile = true) {
  let handle
  let buffer
  try {
    if ((await realpath(dirname(path))) !== dirname(path)) throw unsafe()
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > 16 * 1024 * 1024 ||
      (privateFile && before.mode & 0o077)
    )
      throw unsafe()
    buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await handle.stat()
    if (length !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size)
      throw changed()
    return JSON.parse(buffer.subarray(0, length).toString('utf8'))
  } finally {
    buffer?.fill(0)
    await handle?.close()
  }
}
export async function writeRefreshJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
function validReceipt(value) {
  if (
    !object(value) ||
    value.version !== 1 ||
    !['pi', 'omp'].includes(value.cli) ||
    !Array.isArray(value.entries)
  )
    throw unsafe()
  for (const entry of value.entries)
    if (
      !object(entry) ||
      typeof entry.provider !== 'string' ||
      typeof entry.path !== 'string' ||
      typeof entry.hash !== 'string'
    )
      throw unsafe()
  return value
}
async function sourceIdentity(entry) {
  if ((await realpath(dirname(entry.path))) !== dirname(entry.path)) throw changed()
  const info = await lstat(entry.path)
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1 ||
    info.dev !== entry.dev ||
    info.ino !== entry.ino
  )
    throw changed()
}
function rowCredential(row) {
  if (!row || row.credential_type !== 'oauth' || row.disabled_cause) return undefined
  return { ...JSON.parse(row.data), type: 'oauth' }
}
export async function assertPiOmpRefreshSources(root, expected) {
  const receipt = validReceipt(expected ?? (await refreshJson(join(root, 'receipt.json'))))
  for (const entry of receipt.entries) {
    await sourceIdentity(entry)
    let current
    if (receipt.cli === 'pi') current = (await refreshJson(entry.path, false))[entry.provider]
    else {
      const db = new DatabaseSync(entry.path, { readOnly: true })
      try {
        current = rowCredential(
          db
            .prepare(
              'SELECT credential_type,data,disabled_cause FROM auth_credentials WHERE rowid=? AND provider=?',
            )
            .get(entry.rowId, entry.provider),
        )
      } finally {
        db.close()
      }
    }
    if (
      !current ||
      refreshFingerprint(current) !== entry.hash ||
      refreshPrincipal(current) !== entry.principal
    )
      throw changed()
  }
  return receipt
}
export async function assertPiOmpRefreshCache(root, receipt) {
  await refreshedEntries(root, validReceipt(receipt))
}
async function refreshedEntries(root, receipt) {
  const result = []
  if (receipt.cli === 'pi') {
    const data = await refreshJson(join(root, 'agent/auth.json'))
    const expected = [...receipt.entries, ...(receipt.fixed ?? [])].map((entry) => entry.provider).sort()
    if (refreshFingerprint(Object.keys(data).sort()) !== refreshFingerprint(expected)) throw unsafe()
    for (const entry of receipt.fixed ?? [])
      if (refreshFingerprint(data[entry.provider]) !== entry.hash) throw unsafe()
    for (const entry of receipt.entries) result.push([entry, data[entry.provider]])
  } else {
    const db = new DatabaseSync(join(root, 'agent/agent.db'), { readOnly: true })
    try {
      const rows = db
        .prepare('SELECT rowid AS id,provider,credential_type,data,disabled_cause FROM auth_credentials')
        .all()
      if (rows.length !== receipt.entries.length + (receipt.fixed?.length ?? 0)) throw unsafe()
      for (const entry of receipt.fixed ?? []) {
        const row = rows.find((row) => row.id === entry.cacheRowId && row.provider === entry.provider)
        if (
          !row ||
          refreshFingerprint({
            ...JSON.parse(row.data),
            type: row.credential_type,
            disabled_cause: row.disabled_cause,
          }) !== entry.hash
        )
          throw unsafe()
      }
      for (const entry of receipt.entries)
        result.push([
          entry,
          rowCredential(
            db
              .prepare(
                'SELECT credential_type,data,disabled_cause FROM auth_credentials WHERE rowid=? AND provider=?',
              )
              .get(entry.cacheRowId, entry.provider),
          ),
        ])
    } finally {
      db.close()
    }
  }
  for (const [entry, next] of result)
    if (
      !next ||
      refreshPrincipal(next) !== entry.principal ||
      typeof next.access !== 'string' ||
      !next.access ||
      typeof next.refresh !== 'string' ||
      !next.refresh ||
      !Number.isFinite(next.expires)
    )
      throw unsafe()
  return result
}
/** Called only by Host after capture/process-scope cleanup confirmed exit. */
export async function finishPiOmpRefresh(root, nonce, executable, expectedReceipt) {
  if (!(await ownsOwnAccountLease(root, nonce))) return
  try {
    // This snapshot is retained in the Host closure before launch. Never trust a
    // runtime-writable receipt to select unsandboxed source write destinations.
    const receipt = validReceipt(expectedReceipt)
    const entries = await refreshedEntries(root, receipt)
    for (const [entry, next] of entries) {
      if (refreshFingerprint(next) === entry.hash) continue
      await sourceIdentity(entry)
      if (receipt.cli === 'pi') {
        const { dist } = inspectPiInstallation(executable)
        const require = createRequire(join(dist, 'core/auth-storage.js'))
        const lockfile = require('proper-lockfile')
        // Same canonical auth path and lock convention as Pi 1.0.4. Never call
        // AuthStorage.create here: its initialization would recreate a logged-out file.
        const unlock = await lockfile.lock(entry.path, { realpath: false, retries: 0, stale: 30000 })
        try {
          await sourceIdentity(entry)
          const data = await refreshJson(entry.path, false)
          if (
            refreshFingerprint(data[entry.provider]) !== entry.hash ||
            refreshPrincipal(data[entry.provider]) !== entry.principal
          )
            throw changed()
          const handle = await open(
            entry.path,
            constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          )
          try {
            const info = await handle.stat()
            if (info.dev !== entry.dev || info.ino !== entry.ino || info.nlink !== 1) throw changed()
            const bytes = Buffer.from(JSON.stringify({ ...data, [entry.provider]: next }, null, 2))
            try {
              let offset = 0
              while (offset < bytes.length) {
                const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
                if (!bytesWritten) throw unsafe()
                offset += bytesWritten
              }
              await handle.truncate(bytes.length)
              await handle.sync()
            } finally {
              bytes.fill(0)
            }
          } finally {
            await handle.close()
          }
        } finally {
          await unlock()
        }
      } else {
        // SQLite URI mode=rw never recreates a source deleted after preflight.
        const db = new DatabaseSync(`${pathToFileURL(entry.path).href}?mode=rw`)
        try {
          db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
          const row = db
            .prepare(
              'SELECT credential_type,data,disabled_cause FROM auth_credentials WHERE rowid=? AND provider=?',
            )
            .get(entry.rowId, entry.provider)
          const current = rowCredential(row)
          if (
            !current ||
            refreshFingerprint(current) !== entry.hash ||
            refreshPrincipal(current) !== entry.principal
          )
            throw changed()
          const { type: _type, ...data } = next
          const update = db
            .prepare(
              'UPDATE auth_credentials SET data=? WHERE rowid=? AND provider=? AND credential_type=? AND data=? AND disabled_cause IS NULL',
            )
            .run(JSON.stringify(data), entry.rowId, entry.provider, 'oauth', row.data)
          if (Number(update.changes) !== 1) throw changed()
          db.exec('COMMIT')
        } catch (error) {
          try {
            db.exec('ROLLBACK')
          } catch {}
          throw error
        } finally {
          db.close()
        }
      }
      // Reuse the updated Host-held expectation in the next metadata phase and
      // this same prepare's final worker request; don't reject our own refresh.
      entry.hash = refreshFingerprint(next)
    }
    await writeRefreshJson(join(root, 'receipt.json'), receipt)
  } catch (error) {
    if (
      error?.message === '账号配置已变化，请重新刷新模型' ||
      error?.message === '无法安全保存账号续期，请重新登录'
    )
      throw error
    throw unsafe()
  } finally {
    // A CAS conflict is a completed safe refusal, not an unconfirmed process exit.
    await releaseOwnAccountLease(root, nonce)
  }
}
