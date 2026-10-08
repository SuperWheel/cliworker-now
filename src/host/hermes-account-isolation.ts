import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseEnv } from 'node:util'

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep)

function canonical(path: string): string {
  const suffix: string[] = []
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...suffix)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error
      suffix.unshift(basename(current))
    }
  }
}

/** Read only Hermes' own dotenv to locate foreign-account overrides. Never read
 * the foreign credential files, and never publish any dotenv values. */
function ownEnvironment(home: string): Record<string, string | undefined> {
  let fd: number | undefined
  let buffer: Buffer | undefined
  try {
    fd = openSync(join(home, '.env'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('Unsafe dotenv')
    buffer = readFileSync(fd)
    if (buffer.length > 1024 * 1024) throw new Error('Unsafe dotenv')
    return parseEnv(buffer.toString('utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error('Hermes 账号环境无法安全读取')
  } finally {
    buffer?.fill(0)
    if (fd !== undefined) closeSync(fd)
  }
}

/** The native interactive Codex login imports CODEX_HOME/auth.json even with
 * auth.adopt_external_logins=false (auth_codex._login_openai_codex). Claude's
 * borrowed file/Keychain reader currently honors that flag; block both underlying
 * sources too, consistently for menus, catalogs and tasks. Own Hermes OAuth is
 * stored in HERMES_HOME JSON files and does not invoke the security command. */
export function hermesAccountIsolationPolicy(home: string, cwd: string): string {
  const own = canonical(home)
  const local = ownEnvironment(own)
  const userHomes = new Set([homedir()])
  const path = (value: string, userHome: string) => {
    if (/[\x00-\x1f$]/.test(value) || (value.startsWith('~') && !value.startsWith('~/')))
      throw new Error('Hermes 外部账号路径无法安全隔离')
    const expanded = value.startsWith('~/') ? join(userHome, value.slice(2)) : value
    return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded))
  }
  // python-dotenv can replace HOME before Path.home()/expanduser() is evaluated.
  if (local.HOME?.trim()) userHomes.add(path(local.HOME.trim(), homedir()))
  const roots = new Set<string>()
  const files = new Set<string>()
  for (const userHome of userHomes) {
    for (const [key, defaultName, credential] of [
      ['CODEX_HOME', '.codex', 'auth.json'],
      ['CLAUDE_CONFIG_DIR', '.claude', '.credentials.json'],
    ] as const) {
      const candidates = [join(userHome, defaultName), process.env[key]?.trim(), local[key]?.trim()]
      for (const candidate of candidates) {
        if (!candidate) continue
        const lexical = path(candidate, userHome)
        const root = canonical(lexical)
        if (inside(own, root) || inside(root, own)) throw new Error('Hermes 与外部 CLI 账号目录重叠')
        roots.add(lexical)
        roots.add(root)
        // Existing symlinked credential files may point outside their config root.
        const target = canonical(join(root, credential))
        if (inside(target, own)) throw new Error('Hermes 与外部 CLI 账号文件重叠')
        files.add(target)
      }
    }
  }
  const denied = [
    ...[...roots].map((value) => `(subpath ${JSON.stringify(value)})`),
    ...[...files].map((value) => `(literal ${JSON.stringify(value)})`),
  ]
  return `\n(deny file-read-data ${denied.join(' ')})\n(deny process-exec (regex #"(^|/)security$"))\n`
}
