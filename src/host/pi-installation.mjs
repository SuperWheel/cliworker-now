// One verified Pi package for the Host, account UI, native catalog and RPC entry.
// Resolve installation metadata only; never execute an arbitrary shell launcher.
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveNativeEntry } from './native-launch.mjs'

const versions = new Set(['1.0.2', '1.0.4'])
const failure = () =>
  Object.assign(
    new Error('Pi 安装身份或原生接口不匹配；需要 Pi Coding Agent 1.0.2 或 1.0.4，不能使用 OMP 入口'),
    { code: 'CLI_IDENTITY_MISMATCH' },
  )
function metadata(path) {
  const info = statSync(path)
  if (!info.isFile() || info.size > 128 * 1024) throw failure()
  return readFileSync(path, 'utf8')
}

export function inspectPiInstallation(entry) {
  try {
    let executable = realpathSync(entry)
    if (
      ['pi', 'pi.cmd', 'pi.bat'].includes(basename(executable).toLowerCase()) &&
      basename(dirname(executable)) === 'bin'
    ) {
      const launcher = metadata(executable)
      if (launcher.includes('PI_MANAGED_INSTALL_ROOT=') && launcher.includes('install/current-version')) {
        const install = join(dirname(dirname(executable)), 'install')
        const version = metadata(join(install, 'current-version')).trim()
        if (!versions.has(version)) throw failure()
        executable = realpathSync(
          join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
        )
      }
    }
    executable = realpathSync(resolveNativeEntry(executable))
    let directory = dirname(executable)
    for (let depth = 0; depth < 5; depth++, directory = dirname(directory)) {
      let manifest
      try {
        manifest = JSON.parse(metadata(join(directory, 'package.json')))
      } catch {
        continue
      }
      if (manifest.name !== '@earendil-works/pi-coding-agent' || !versions.has(manifest.version))
        throw failure()
      const dist = join(directory, 'dist')
      if (![join(dist, 'cli.js'), join(dist, 'bundle/cli.js')].includes(executable)) throw failure()
      for (const relative of ['cli.js', 'index.js', 'core/model-runtime.js', 'core/auth-storage.js']) {
        if (!statSync(join(dist, relative)).isFile()) throw failure()
      }
      return {
        root: directory,
        dist,
        version: manifest.version,
        executable: realpathSync(join(dist, 'cli.js')),
      }
    }
  } catch {
    throw failure()
  }
  throw failure()
}
