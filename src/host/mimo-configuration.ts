import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AccountIdentity } from './account-identity.ts'

export class MimoConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MimoConfigurationError'
  }
}
const unavailable = () => new MimoConfigurationError('MiMo 配置来源无法确认，请检查配置')
const interpolation = () => new MimoConfigurationError('MiMo 配置含外部引用，请改为本 CLI 配置')
const remote = () => new MimoConfigurationError('MiMo 远程配置无法核验，请使用本地配置')

/** Mirrors native Global.Path; arbitrary config/content/DB selectors are cleared in the child. */
export function mimoConfigurationPaths() {
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  const root = process.env.MIMOCODE_HOME
  const config = root
    ? join(root, 'config')
    : join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'mimocode')
  const data = root
    ? join(root, 'data')
    : join(process.env.XDG_DATA_HOME || join(home, '.local/share'), 'mimocode')
  if (![home, config, data, ...(root ? [root] : [])].every(isAbsolute)) throw unavailable()
  return { home, config, data }
}

export async function mimoConfigurationFiles(project: string): Promise<string[]> {
  if (!isAbsolute(project)) throw unavailable()
  const { home, config } = mimoConfigurationPaths()
  const files = new Set([join(config, 'config.json')])
  const add = (directory: string) => {
    files.add(join(directory, 'mimocode.json'))
    files.add(join(directory, 'mimocode.jsonc'))
  }
  add(config)
  add(join(home, '.mimocode'))
  // Native stops at the worktree; checking every ancestor also covers unversioned projects.
  let physical: string
  try {
    physical = await realpath(project)
  } catch {
    throw unavailable()
  }
  for (const start of new Set([resolve(project), physical])) {
    for (let directory = start; ; directory = dirname(directory)) {
      add(directory)
      add(join(directory, '.mimocode'))
      if (dirname(directory) === directory) break
    }
  }
  return [...files]
}

async function exists(path: string) {
  try {
    await lstat(path)
    return true
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw unavailable()
  }
}

async function ownDirectory(path: string) {
  try {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
  } catch (error: any) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw unavailable()
  }
}

async function readConfiguration(path: string, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted()
  let file, bytes: Buffer | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > 1_048_576) throw unavailable()
    bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat()
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw unavailable()
    return bytes.subarray(0, before.size).toString('utf8')
  } catch (error: any) {
    signal.throwIfAborted()
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw unavailable()
  } finally {
    bytes?.fill(0)
    await file?.close()
  }
}

/** Auth.Service reads this file independently of model/project configuration. */
export async function readMimoOwnAuth(signal: AbortSignal): Promise<Record<string, any>> {
  const { data } = mimoConfigurationPaths()
  for (const directory of [process.env.MIMOCODE_HOME, data]) if (directory) await ownDirectory(directory)
  const text = await readConfiguration(join(data, 'auth.json'), signal)
  if (!text) return {}
  try {
    const auth = JSON.parse(text)
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw unavailable()
    return auth
  } catch {
    throw unavailable()
  }
}

export async function readMimoAccount(signal: AbortSignal): Promise<AccountIdentity> {
  const auth = (await readMimoOwnAuth(signal)).xiaomi
  signal.throwIfAborted()
  if (!auth) return { state: 'unconfigured', summary: '尚未登录 MiMo', verification: 'local' }
  // The built-in browser login persists ApiAuth, including optional uid/base_url metadata.
  if (auth.type === 'api' && typeof auth.key === 'string' && auth.key.trim())
    return { state: 'authenticated', summary: 'MiMo 登录', authMethod: 'api', verification: 'local' }
  return { state: 'configured', summary: '已配置 MiMo 账号，请检查登录', verification: 'local' }
}

/** Only unavoidable external inputs remain relevant in an isolated account terminal. */
export async function assertMimoAccountConfiguration(signal: AbortSignal): Promise<void> {
  if (Object.values(await readMimoOwnAuth(signal)).some((value) => value?.type === 'wellknown'))
    throw remote()
  if (process.platform === 'darwin')
    for (const path of [
      join('/Library/Managed Preferences', userInfo().username, 'ai.opencode.managed.plist'),
      '/Library/Managed Preferences/ai.opencode.managed.plist',
    ])
      if (await exists(path)) throw unavailable()
  signal.throwIfAborted()
}

/** Native Config.Service expands references before returning metadata, so inspect before spawning it. */
export async function assertMimoConfiguration(project: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const { home, config, data } = mimoConfigurationPaths()
  for (const directory of [process.env.MIMOCODE_HOME, config, data, join(home, '.mimocode')])
    if (directory) await ownDirectory(directory)
  for (const path of await mimoConfigurationFiles(project)) {
    if (dirname(path).endsWith('/.mimocode')) await ownDirectory(dirname(path))
    const text = await readConfiguration(path, signal)
    // Native substitution happens on raw JSON/JSONC before parsing, including non-auth fields.
    if (text && /\{(?:file|env):/.test(text)) throw interpolation()
  }
  // Legacy TOML is imported by native code; managed OpenCode sources do not belong to this CLI.
  const unsupported = [join(config, 'config')]
  const managed =
    process.platform === 'darwin'
      ? '/Library/Application Support/opencode'
      : process.platform === 'win32'
        ? join(process.env.ProgramData || 'C:\\ProgramData', 'opencode')
        : '/etc/opencode'
  unsupported.push(join(managed, 'mimocode.json'), join(managed, 'mimocode.jsonc'))
  if (process.platform === 'darwin')
    unsupported.push(
      join('/Library/Managed Preferences', userInfo().username, 'ai.opencode.managed.plist'),
      '/Library/Managed Preferences/ai.opencode.managed.plist',
    )
  for (const path of unsupported) if (await exists(path)) throw unavailable()
  const authText = await readConfiguration(join(data, 'auth.json'), signal)
  if (authText) {
    let auth: unknown
    try {
      auth = JSON.parse(authText)
    } catch {
      throw unavailable()
    }
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw unavailable()
    if (Object.values(auth).some((value) => value?.type === 'wellknown')) throw remote()
  }
  // An active console org supplies remote JSON that native then interpolates. Only inspect its
  // presence; no tokens, account details, or remote config are read or requested here.
  let names: string[]
  try {
    names = await readdir(data)
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw unavailable()
    names = []
  }
  for (const name of names.filter((name) => /^mimocode(?:-[A-Za-z0-9._-]+)?\.db$/.test(name))) {
    signal.throwIfAborted()
    const path = join(data, name)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unavailable()
    const { DatabaseSync } = await import('node:sqlite')
    signal.throwIfAborted()
    let db: InstanceType<typeof DatabaseSync> | undefined
    let active = false
    try {
      db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
      db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF')
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_state'").get())
        active = !!db.prepare('SELECT 1 FROM account_state WHERE active_org_id IS NOT NULL LIMIT 1').get()
    } catch {
      throw unavailable()
    } finally {
      db?.close()
    }
    if (active) throw remote()
  }
  signal.throwIfAborted()
}
