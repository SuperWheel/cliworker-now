import { homedir } from 'node:os'
import { basename, dirname, relative, resolve } from 'node:path'

/** OMP 16 resolves its config root with join(os.homedir(), PI_CONFIG_DIR).
 * Windows roots on another drive cannot be expressed relative to the real home.
 * Rebase only this child environment; Host account discovery retains the real home.
 */
export function ompConfigurationEnvironment(configRoot) {
  if (typeof configRoot !== 'string' || !configRoot.trim() || configRoot.includes('\0'))
    throw new Error('Invalid OMP configuration root')
  const root = resolve(configRoot)
  if (process.platform === 'win32')
    return { HOME: dirname(root), USERPROFILE: dirname(root), PI_CONFIG_DIR: basename(root) }
  return { PI_CONFIG_DIR: relative(homedir(), root) }
}
