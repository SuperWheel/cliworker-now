import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountAction } from '../shared/accounts.ts'
import { firstPartyEnvironment } from './first-party-models.ts'
import { assertMimoAccountConfiguration, mimoConfigurationPaths } from './mimo-configuration.ts'

/** Native login keeps the same auth store, but never initializes project/model configuration. */
export async function prepareMimoAccountTerminal(
  executable: string,
  action: AccountAction,
  stateDirectory: string,
  signal: AbortSignal,
) {
  await assertMimoAccountConfiguration(signal)
  const { data } = mimoConfigurationPaths()
  const parent = join(stateDirectory, 'account-contexts', 'mimo')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'login-'))
  try {
    for (const directory of ['home', 'config', 'data', 'cache', 'state', 'work', 'managed'])
      await mkdir(join(root, directory), { mode: 0o700 })
    // Native Auth.set writes through this link. No credential snapshot is made, including
    // for a first login; logout and subsequent status read the original native path.
    await mkdir(data, { recursive: true, mode: 0o700 })
    await symlink(join(data, 'auth.json'), join(root, 'data', 'auth.json'))
    signal.throwIfAborted()
    return {
      argv: [executable, ...(action === 'manage' ? [] : ['auth', action])],
      cwd: join(root, 'work'),
      env: {
        ...firstPartyEnvironment('mimo'),
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        MIMOCODE_HOME: root,
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
