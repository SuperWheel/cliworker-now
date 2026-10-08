import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { hermesNativeCommand, hermesCommandInstallationHome } from '../src/host/hermes-installation.ts'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })))
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-install-synthetic-')))
  roots.push(home)
  const checkout = join(home, 'hermes-agent'),
    key = createHash('sha256').update(checkout).digest('hex').slice(0, 16)
  const install = join(home, 'installs', key),
    environment = join(install, 'environments', 'a'.repeat(32), 'venv'),
    launcher = join(checkout, '.hermes/bin/hermes'),
    facts = join(install, 'facts.json')
  for (const path of [
    join(checkout, '.hermes/bin'),
    join(checkout, 'hermes_cli'),
    join(checkout, 'pm'),
    join(environment, 'bin'),
  ])
    mkdirSync(path, { recursive: true })
  writeFileSync(launcher, `#!/bin/sh\n# synthetic hermes_bootstrap ${checkout}\n`, { mode: 0o700 })
  writeFileSync(join(checkout, 'hermes_bootstrap.py'), '# synthetic')
  writeFileSync(
    join(checkout, 'hermes_cli/main.py'),
    "from hermes_cli.env_loader import load_hermes_dotenv\ndef main():\n    load_hermes_dotenv(project_env='synthetic-foreign.env')\n    print('synthetic-menu')\n",
  )
  writeFileSync(
    join(checkout, 'hermes_cli/env_loader.py'),
    "def load_hermes_dotenv(**options):\n    assert options['project_env'] is None\n    assert options['load_external_secrets'] is False\n",
  )
  writeFileSync(
    join(checkout, 'hermes_cli/runtime_state.py'),
    `from pathlib import Path\ndef lease_generation(environment):\n    Path(${JSON.stringify(join(home, 'leased'))}).write_text('lease')\n    return lambda: Path(${JSON.stringify(join(home, 'leased'))}).unlink()\n`,
  )
  writeFileSync(join(checkout, 'pm/environments.py'), '# synthetic')
  writeFileSync(join(environment, 'pyvenv.cfg'), '# synthetic metadata; no real virtualenv')
  symlinkSync('/usr/bin/python3', join(environment, 'bin/python'))
  writeFileSync(facts, JSON.stringify({ packages: { venv: { environment } } }))
  return { home, checkout, environment, launcher, facts }
}
describe('Hermes installation-bound entry (synthetic, no account/network)', () => {
  it('uses the exact committed environment and preserves native argv while leasing and releasing', async () => {
    const f = fixture(),
      command = await hermesNativeCommand(f.launcher, ['model'])
    expect(command[0]).toBe(join(f.environment, 'bin/python'))
    expect(hermesCommandInstallationHome(command)).toBe(f.home)
    expect(command.at(-1)).toBe('model')
    expect(
      execFileSync(command[0]!, command.slice(1), {
        encoding: 'utf8',
        env: { ...process.env, HERMES_HOME: join(f.home, 'account') },
      }),
    ).toBe('synthetic-menu\n')
    expect(() => readFileSync(join(f.home, 'leased'))).toThrow()
  })
  it('refuses a changed selection at child startup without opening the native menu', async () => {
    const f = fixture(),
      command = await hermesNativeCommand(f.launcher, ['auth'])
    writeFileSync(
      f.facts,
      JSON.stringify({ packages: { venv: { environment: join(f.home, 'uncommitted') } } }),
    )
    expect(() => execFileSync(command[0]!, command.slice(1), { stdio: 'pipe' })).toThrow()
    expect(() => readFileSync(join(f.home, 'leased'))).toThrow()
  })
  it('never falls back to an arbitrary existing generation when facts are missing or escaping', async () => {
    const f = fixture()
    writeFileSync(f.facts, JSON.stringify({ packages: { venv: { environment: f.home } } }))
    await expect(hermesNativeCommand(f.launcher, ['model'])).rejects.toThrow('安装依赖不可用')
    rmSync(f.facts)
    await expect(hermesNativeCommand(f.launcher, ['model'])).rejects.toThrow('安装依赖不可用')
  })
})
