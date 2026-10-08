import { afterEach, describe, expect, it } from 'vitest'
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
import { hermesSandbox } from '../src/host/hermes-sandbox.ts'

const roots: string[] = []
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-sandbox-synthetic-')))
  roots.push(root)
  const home = join(root, 'native-home'),
    state = join(root, 'private'),
    project = join(root, 'project')
  const install = join(home, 'installs/0123456789abcdef')
  const generation = join(install, 'environments/0123456789abcdef0123456789abcdef')
  const pmGeneration = join(install, 'pm-runtime/generations/fedcba9876543210fedcba9876543210')
  for (const path of [
    home,
    state,
    project,
    join(home, 'logs'),
    join(home, 'sessions'),
    join(home, 'hermes-agent'),
    join(generation, 'venv'),
    join(generation, '.leases'),
    join(pmGeneration, '.leases'),
  ])
    mkdirSync(path, { recursive: true })
  for (const name of ['config.yaml', '.env', 'auth.json', 'hermes-agent/source.py'])
    writeFileSync(
      join(home, name),
      name === '.env' ? '# synthetic protected fixture' : 'synthetic protected fixture',
    )
  writeFileSync(join(generation, '.lease-managed'), '')
  writeFileSync(join(pmGeneration, '.lease-managed'), '')
  writeFileSync(
    join(install, 'pm-runtime/selected.json'),
    JSON.stringify({ generation: 'generations/fedcba9876543210fedcba9876543210' }),
  )
  writeFileSync(
    join(install, 'facts.json'),
    JSON.stringify({ packages: { venv: { environment: join(generation, 'venv') } } }),
  )
  return { root, home, state, project, install, generation, pmGeneration }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'darwin')(
  'Hermes task sandbox (synthetic local files, no model)',
  () => {
    it('fails closed for a writable root containing native credentials', () => {
      const f = fixture()
      for (const [state, project] of [
        [f.root, f.project],
        [f.state, f.root],
        [f.state, f.home],
      ])
        expect(() => hermesSandbox(['true'], state!, project!, 'accept-edits', f.home)).toThrow(
          '不能与任务目录',
        )
    })
    it('rejects symlinked runtime directories and dependency targets', () => {
      const f = fixture()
      rmSync(join(f.home, 'sessions'), { recursive: true })
      symlinkSync(join(f.home, 'hermes-agent'), join(f.home, 'sessions'))
      expect(() => hermesSandbox(['true'], f.state, f.project, 'plan', f.home)).toThrow('symlink')
    })
    it('does not authorize dependencies by an escaping or non-canonical facts path', () => {
      const f = fixture()
      writeFileSync(
        join(f.install, 'facts.json'),
        JSON.stringify({
          packages: { venv: { environment: join(f.install, 'environments') + '/../source' } },
        }),
      )
      expect(() => hermesSandbox(['true'], f.state, f.project, 'plan', f.home)).toThrow('Unsafe')
    })
    it.each(['plan', 'accept-edits'] as const)('enforces runtime-only native home writes in %s', (mode) => {
      const f = fixture()
      const allowed = [
        join(f.state, 'temporary'),
        join(f.home, 'logs/run.log'),
        join(f.home, 'sessions/session.jsonl'),
        join(f.home, 'state.db'),
        join(f.home, 'state.db-wal'),
        join(f.home, 'state.db-shm'),
        join(f.install, '.install.lock'),
        join(f.generation, '.leases/test-lease'),
        join(f.install, 'pm-runtime/.prepare.lock'),
        join(f.pmGeneration, '.leases/test-lease'),
      ]
      const protectedPaths = [
        'config.yaml',
        '.env',
        'auth.json',
        'hermes-agent/source.py',
        'new-config.yaml',
        'installs/new-install',
        'installs/0123456789abcdef/facts.json',
        'installs/0123456789abcdef/pm-runtime/selected.json',
        'installs/0123456789abcdef/pm-runtime/generations/fedcba9876543210fedcba9876543210/new.py',
        'installs/0123456789abcdef/environments/0123456789abcdef0123456789abcdef/venv/new.py',
      ].map((path) => join(f.home, path))
      const workspaceFile = join(f.project, 'output.txt')
      const script = `const fs=require('fs'); const data=JSON.parse(process.argv[1]);
      const write=p=>{try{fs.writeFileSync(p,'changed');return true}catch(e){return e.code}};
      process.stdout.write(JSON.stringify({allowed:data.allowed.map(write),protected:data.protected.map(write),project:write(data.workspaceFile)}));`
      const argv = hermesSandbox(
        [
          process.execPath,
          '-e',
          script,
          JSON.stringify({ allowed, protected: protectedPaths, workspaceFile }),
        ],
        f.state,
        f.project,
        mode,
        f.home,
      )
      const result = JSON.parse(execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' }))
      expect(result.allowed).toEqual(allowed.map(() => true))
      expect(result.protected.every((item: unknown) => item === 'EPERM' || item === 'EACCES')).toBe(true)
      expect(result.project).toBe(mode === 'accept-edits' ? true : 'EPERM')
      for (const name of ['config.yaml', '.env', 'auth.json', 'hermes-agent/source.py'])
        expect(readFileSync(join(f.home, name), 'utf8')).toBe(
          name === '.env' ? '# synthetic protected fixture' : 'synthetic protected fixture',
        )
    })
    it('a symlink made after policy creation cannot turn a log path into credential writes', () => {
      const f = fixture()
      const link = join(f.home, 'logs/credential-link')
      const script = `const fs=require('fs');try{fs.writeFileSync(process.argv[1],'changed');process.stdout.write('wrote')}catch(e){process.stdout.write(e.code)}`
      const argv = hermesSandbox([process.execPath, '-e', script, link], f.state, f.project, 'plan', f.home)
      symlinkSync(join(f.home, 'auth.json'), link)
      expect(execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })).toBe('EPERM')
      expect(readFileSync(join(f.home, 'auth.json'), 'utf8')).toBe('synthetic protected fixture')
    })
    it('a child cannot hard-link native credentials into its writable log directory', () => {
      const f = fixture()
      const script = `const fs=require('fs');try{fs.linkSync(process.argv[1],process.argv[2]);fs.writeFileSync(process.argv[2],'changed');process.stdout.write('wrote')}catch(e){process.stdout.write(e.code)}`
      const argv = hermesSandbox(
        [process.execPath, '-e', script, join(f.home, 'auth.json'), join(f.home, 'logs/alias')],
        f.state,
        f.project,
        'plan',
        f.home,
      )
      expect(execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })).toBe('EPERM')
      expect(readFileSync(join(f.home, 'auth.json'), 'utf8')).toBe('synthetic protected fixture')
    })
  },
)
