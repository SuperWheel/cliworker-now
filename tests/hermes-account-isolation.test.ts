import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermesAccountIsolationPolicy } from '../src/host/hermes-account-isolation.ts'
import { hermesSandbox } from '../src/host/hermes-sandbox.ts'
import { prepareHermesAccountHome } from '../src/host/hermes-account-context.ts'
import { prepareHermesAccount } from '../src/host/hermes-accounts.ts'
import { DEFAULT_CONFIG } from '../src/host/process.ts'

const roots: string[] = []
const secret = 'explicit-synthetic-credential'
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-account-isolation-synthetic-')))
  roots.push(root)
  const userHome = join(root, 'user'),
    home = join(userHome, '.hermes')
  const state = join(root, 'state'),
    project = join(root, 'project')
  for (const directory of [home, state, project, join(home, 'logs'), join(home, 'sessions')])
    mkdirSync(directory, { recursive: true })
  vi.stubEnv('HOME', userHome)
  vi.stubEnv('CODEX_HOME', join(root, 'configured-codex'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'configured-claude'))
  const foreign = [
    join(userHome, '.codex/auth.json'),
    join(userHome, '.claude/.credentials.json'),
    join(userHome, '.config/gh/hosts.yml'),
    join(userHome, '.qwen/oauth_creds.json'),
    join(root, 'checkout/.env'),
    join(root, 'checkout/.op.env'),
    join(root, 'configured-codex/auth.json'),
    join(root, 'configured-claude/.credentials.json'),
    join(userHome, 'dotenv-codex/auth.json'),
    join(userHome, 'dotenv-claude/.credentials.json'),
  ]
  for (const file of foreign) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, secret)
  }
  // A native config directory can be an alias, and its auth file can itself be one.
  const aliasRoot = join(root, 'alias-codex')
  mkdirSync(aliasRoot)
  symlinkSync(aliasRoot, join(userHome, 'codex-directory-alias'))
  writeFileSync(join(aliasRoot, 'auth.json'), secret)
  vi.stubEnv('CODEX_HOME', join(userHome, 'codex-directory-alias'))
  foreign.push(join(aliasRoot, 'auth.json'), join(userHome, 'codex-directory-alias/auth.json'))
  const outside = join(root, 'auth-file-target')
  writeFileSync(outside, secret)
  rmSync(foreign[0]!)
  symlinkSync(outside, foreign[0]!)
  foreign.push(outside)
  // Keep the first configured path in the foreign fixture list selected as well.
  foreign.splice(6, 1)
  writeFileSync(join(home, 'config.yaml'), 'auth:\n  adopt_external_logins: false\n')
  writeFileSync(join(home, '.env'), 'CODEX_HOME=~/dotenv-codex\nCLAUDE_CONFIG_DIR=~/dotenv-claude\n')
  const own = [join(home, 'auth.json'), join(home, '.anthropic_oauth.json'), join(home, '.env')]
  for (const file of own.slice(0, 2)) writeFileSync(file, secret)
  writeFileSync(own[0]!, JSON.stringify({ fixture: secret }))
  // This is a harmless stand-in, never the real Keychain executable.
  const security = join(root, 'security')
  writeFileSync(security, '#!/bin/sh\nprintf synthetic-security-executed\n', { mode: 0o700 })
  const data = { own, foreign, security, session: join(home, 'sessions/synthetic.jsonl') }
  const script = `const fs=require('fs'),cp=require('child_process');const data=${JSON.stringify(data)};
    const readable=p=>{try{fs.readFileSync(p);return true}catch(e){return e.code}};
    const result={own:data.own.map(readable),foreign:data.foreign.map(readable)};
    try{cp.execFileSync(data.security);result.security=true}catch(e){result.security=e.code}
    fs.writeFileSync(data.session,'synthetic-session');
    process.stdout.write(JSON.stringify(result));`
  return { root, userHome, home, state, project, foreign, own, script }
}
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'darwin')('Hermes foreign-account sandbox (synthetic, offline)', () => {
  it.each(['catalog', 'plan', 'accept-edits'] as const)(
    'blocks borrowed credentials in %s while own OAuth/session files remain usable',
    (mode) => {
      const f = fixture()
      const argv = hermesSandbox(
        [process.execPath, '-e', f.script],
        f.state,
        mode === 'catalog' ? f.state : f.project,
        mode === 'accept-edits' ? mode : 'plan',
        f.home,
      )
      const result = JSON.parse(
        execFileSync(argv[0]!, argv.slice(1), {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: f.userHome },
        }),
      )
      expect(result.own).toEqual([true, true, true])
      expect(result.foreign.every((value: unknown) => value === 'EPERM' || value === 'EACCES')).toBe(true)
      expect(['EPERM', 'EACCES']).toContain(result.security)
      expect(readFileSync(join(f.home, 'sessions/synthetic.jsonl'), 'utf8')).toBe('synthetic-session')
      for (const file of f.foreign) expect(readFileSync(file, 'utf8')).toBe(secret)
    },
  )

  it.each(['login', 'manage'] as const)(
    'blocks interactive imports in %s and retains own credential writes',
    async (action) => {
      const f = fixture()
      const executable = join(f.root, 'hermes-synthetic')
      const script = f.script.replace(
        "fs.writeFileSync(data.session,'synthetic-session');",
        "fs.writeFileSync(data.session,'synthetic-session');fs.writeFileSync(data.own[0],'synthetic-refreshed-own');",
      )
      writeFileSync(executable, `#!${process.execPath}\n${script}`, { mode: 0o700 })
      const accountConfig = { ...DEFAULT_CONFIG, hermesHome: f.home, stateDirectory: f.state }
      const ownHome = prepareHermesAccountHome(accountConfig)
      writeFileSync(join(ownHome, '.env'), readFileSync(join(f.home, '.env')))
      const prepared = await prepareHermesAccount(
        action,
        executable,
        f.project,
        accountConfig,
        new AbortController().signal,
      )
      try {
        const own = prepared.env.HERMES_HOME!
        mkdirSync(join(own, 'sessions'), { recursive: true })
        for (const name of ['auth.json', '.anthropic_oauth.json', '.env'])
          writeFileSync(join(own, name), secret)
        writeFileSync(executable, `#!${process.execPath}\n${script.split(f.home).join(own)}`, { mode: 0o700 })
        const result = JSON.parse(
          execFileSync(prepared.argv[0]!, prepared.argv.slice(1), {
            encoding: 'utf8',
            cwd: prepared.cwd,
            env: { PATH: process.env.PATH, HOME: f.userHome, ...prepared.env },
          }),
        )
        expect(result.own).toEqual([true, true, true])
        expect(result.foreign.every((value: unknown) => value === 'EPERM' || value === 'EACCES')).toBe(true)
        expect(['EPERM', 'EACCES']).toContain(result.security)
        expect(readFileSync(join(own, 'auth.json'), 'utf8')).toBe('synthetic-refreshed-own')
        expect(readFileSync(f.own[0]!, 'utf8')).toContain(secret)
        for (const file of f.foreign) expect(readFileSync(file, 'utf8')).toBe(secret)
      } finally {
        await prepared.cleanup()
      }
    },
  )

  it('fails closed for dynamic paths or an override overlapping own Hermes accounts', () => {
    const f = fixture()
    writeFileSync(join(f.home, '.env'), 'CODEX_HOME=${UNPROVEN_DIRECTORY}\n')
    expect(() => hermesAccountIsolationPolicy(f.home, f.state)).toThrow('无法安全读取')
    writeFileSync(join(f.home, '.env'), `CODEX_HOME=${f.home}\n`)
    expect(() => hermesAccountIsolationPolicy(f.home, f.state)).toThrow('重叠')
  })
})
