import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AccountAction } from '../shared/accounts.ts'
import { firstPartyEnvironment } from './first-party-models.ts'
import { assertMimoAccountConfiguration, mimoConfigurationPaths } from './mimo-configuration.ts'

/** Native login keeps the same auth store and a private work directory/database. */
export async function prepareMimoAccountTerminal(
  executable: string,
  action: AccountAction,
  stateDirectory: string,
  signal: AbortSignal,
  options: { platform?: NodeJS.Platform } = {},
) {
  await assertMimoAccountConfiguration(signal)
  const { home, config, data } = mimoConfigurationPaths()
  const direct = (options.platform ?? process.platform) === 'win32'
  const parent = join(stateDirectory, 'account-contexts', 'mimo')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'login-'))
  try {
    for (const directory of ['home', 'config', 'data', 'cache', 'state', 'work', 'managed'])
      await mkdir(join(root, directory), { mode: 0o700 })
    // Windows uses the real native path directly: a symlink needs privileges and an auth
    // copy can restore an account after logout. Other platforms retain the verified link.
    await mkdir(data, { recursive: true, mode: 0o700 })
    if (!direct) await symlink(join(data, 'auth.json'), join(root, 'data', 'auth.json'))
    signal.throwIfAborted()
    return {
      argv: [executable, ...(action === 'manage' ? [] : ['auth', action])],
      cwd: join(root, 'work'),
      env: {
        ...firstPartyEnvironment('mimo'),
        HOME: direct ? home : join(root, 'home'),
        USERPROFILE: direct ? process.env.USERPROFILE || home : join(root, 'home'),
        MIMOCODE_HOME: direct ? process.env.MIMOCODE_HOME || '' : root,
        ...(direct
          ? {
              XDG_DATA_HOME: process.env.XDG_DATA_HOME || dirname(data),
              XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || dirname(config),
              XDG_CACHE_HOME: join(root, 'cache'),
              XDG_STATE_HOME: join(root, 'state'),
            }
          : {}),
        MIMOCODE_DISABLE_PROJECT_CONFIG: '1',
        MIMOCODE_DISABLE_GIT: '1',
        MIMOCODE_MIMO_ONLY: '1',
        MIMOCODE_TEST_MANAGED_CONFIG_DIR: join(root, 'managed'),
        MIMOCODE_TUI_CONFIG: '',
        MIMOCODE_PLUGIN_META_FILE: '',
        MIMOCODE_WORKSPACE_ID: '',
        MIMOCODE_DB: join(root, 'data', 'mimocode.db'),
      },
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
