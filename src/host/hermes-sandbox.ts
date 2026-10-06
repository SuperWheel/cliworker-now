import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { TaskMode } from '../shared/types.ts'
import { validateHermesHomeDirectory } from './hermes-adapter.ts'

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep)
const overlaps = (left: string, right: string) => inside(left, right) || inside(right, left)
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** Never resolve a writable exception through a symlink. The OS policy still checks
 * resolved targets at use time, including links created after this preflight. */
function checkedPath(home: string, path: string, kind: 'file' | 'directory'): string {
  if (resolve(path) !== path || !inside(path, home)) throw new Error('Unsafe Hermes runtime path')
  const parts = relative(home, path).split(sep).filter(Boolean)
  let current = home
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!)
    try {
      const info = lstatSync(current)
      if (info.isSymbolicLink() || realpathSync(current) !== current)
        throw new Error('Unsafe Hermes runtime symlink')
      const directory = index < parts.length - 1 || kind === 'directory'
      if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
        throw new Error('Unsafe Hermes runtime file type or hard link')
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  return path
}

/** Task/catalog policy only. Account-management terminals deliberately use their own
 * native-home policy so explicit login/setup can update credentials and dependencies.
 * Verified against Hermes 4787e4d: runtime_state locks the existing install and leases
 * its selected generation; hermes_state writes the session DB and SQLite sidecars.
 * No package installation, bootstrap migration, config/auth or source writes are granted.
 */
export function hermesSandbox(
  argv: string[],
  state: string,
  project: string,
  mode: TaskMode,
  home: string,
): string[] {
  if (process.platform !== 'darwin') throw new Error('Hermes 当前仅验收 macOS 沙箱；本平台暂不能运行')
  if (!argv.length || argv.some((value) => value.includes('\0'))) throw new Error('Invalid Hermes command')
  if (!['plan', 'accept-edits'].includes(mode)) throw new Error('Invalid Hermes mode')
  const nativeHome = validateHermesHomeDirectory(home)
  if (realpathSync(nativeHome) !== nativeHome || !lstatSync(nativeHome).isDirectory())
    throw new Error('请先在 Hermes 登录设置中初始化原生目录')
  const privateRoot = realpathSync(state)
  const workspace = realpathSync(project)
  // A broad project/state grant must never silently include native credentials/source.
  if (overlaps(privateRoot, nativeHome) || overlaps(workspace, nativeHome))
    throw new Error('Hermes 原生目录不能与任务目录或插件运行目录重叠')

  const directories = ['logs', 'sessions'].map((name) =>
    checkedPath(nativeHome, join(nativeHome, name), 'directory'),
  )
  const files = [
    'state.db',
    'state.db-wal',
    'state.db-shm',
    'state.db-journal',
    'state.db.quarantine.lock',
    'state.db.auto-maintenance.lock',
  ].map((name) => checkedPath(nativeHome, join(nativeHome, name), 'file'))

  const installs = checkedPath(nativeHome, join(nativeHome, 'installs'), 'directory')
  let entries: string[] = []
  try {
    entries = readdirSync(installs)
  } catch (error) {
    if (!missing(error)) throw error
  }
  for (const key of entries) {
    // Only existing native install identities; never permission to provision a new one.
    if (!/^[a-f0-9]{16}$/.test(key)) continue
    const install = checkedPath(nativeHome, join(installs, key), 'directory')
    files.push(checkedPath(nativeHome, join(install, '.install.lock'), 'file'))
    const runtime = checkedPath(nativeHome, join(install, 'pm-runtime'), 'directory')
    const selected = checkedPath(nativeHome, join(runtime, 'selected.json'), 'file')
    try {
      if (lstatSync(selected).size > 64 * 1024) throw new Error('Hermes runtime selection too large')
      const choice = JSON.parse(readFileSync(selected, 'utf8'))
      if (typeof choice?.generation !== 'string' || !/^generations\/[a-f0-9]{32}$/.test(choice.generation))
        throw new Error('Unsafe Hermes runtime selection')
      files.push(checkedPath(nativeHome, join(runtime, '.prepare.lock'), 'file'))
      const generation = checkedPath(nativeHome, join(runtime, choice.generation), 'directory')
      const marker = checkedPath(nativeHome, join(generation, '.lease-managed'), 'file')
      if (lstatSync(marker).isFile())
        directories.push(checkedPath(nativeHome, join(generation, '.leases'), 'directory'))
    } catch (error) {
      if (!missing(error)) throw error
    }
    const facts = checkedPath(nativeHome, join(install, 'facts.json'), 'file')
    try {
      if (lstatSync(facts).size > 4 * 1024 * 1024) throw new Error('Hermes runtime facts too large')
      const data = JSON.parse(readFileSync(facts, 'utf8'))
      const environment: unknown = data?.packages?.venv?.environment
      if (environment === undefined) continue
      if (
        typeof environment !== 'string' ||
        !isAbsolute(environment) ||
        !inside(environment, join(install, 'environments'))
      )
        throw new Error('Unsafe Hermes dependency environment')
      checkedPath(nativeHome, environment, 'directory')
      const generation = dirname(environment)
      // Native lease_directory is a no-op for older, unmarked generations.
      const marker = checkedPath(nativeHome, join(generation, '.lease-managed'), 'file')
      if (lstatSync(marker).isFile())
        directories.push(checkedPath(nativeHome, join(generation, '.leases'), 'directory'))
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`
  const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`
  const writable = [privateRoot, ...directories, ...(mode === 'accept-edits' ? [workspace] : [])]
  const policy = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* ${writable.map(subpath).join(' ')} ${[...files, '/dev/null', '/dev/tty'].map(literal).join(' ')})\n`
  return ['/usr/bin/sandbox-exec', '-p', policy, ...argv]
}
