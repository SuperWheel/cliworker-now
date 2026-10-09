import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerStorage, type DispatchSetup } from '../src/host/storage.ts'
import { CLI_IDS, type CliId } from '../src/shared/types.ts'

// All accounts, parents, projects and roles in these fixtures are synthetic.
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cwn-dispatch-storage-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const open = () => {
    const store = new WorkerStorage(directory)
    cleanups.push(() => store.close())
    return store
  }
  return { directory, store: open(), open }
}
const project = '/synthetic/project'
const parent = 'synthetic-parent'
function setup(cli: CliId = 'pi'): DispatchSetup {
  return {
    preference: { cli, model: 'synthetic-model', effort: 'high' },
    role: { presetId: 'fixture-review', name: '审稿员', summary: '合成角色', prompt: '检查合成证据' },
    binding: 'synthetic-account-binding',
  }
}
function preferencePath(directory: string, cli: CliId = 'pi', selectedProject = project) {
  const key = createHash('sha256')
    .update(cli === 'antigravity' ? selectedProject : JSON.stringify([selectedProject, cli]))
    .digest('hex')
  return join(directory, `${key}.preference.json`)
}
function conversationPath(
  directory: string,
  selectedParent = parent,
  selectedProject = project,
  cli: CliId = 'pi',
) {
  const key = createHash('sha256')
    .update(JSON.stringify([selectedParent, selectedProject, cli]))
    .digest('hex')
  return join(directory, `${key}.conversation-setup.json`)
}

describe('complete private dispatch choices', () => {
  it('survives a Host restart without exposing role or account binding as a public preference', () => {
    const f = fixture()
    const selected = setup()
    f.store.setDispatchSetup(project, selected)
    f.store.setConversationSetup(parent, project, selected)
    expect(f.store.preference(project, 'pi')).toEqual(selected.preference)
    expect(f.store.preference(project, 'pi')).not.toHaveProperty('dispatchBinding')
    expect(f.store.preference(project, 'pi')).not.toHaveProperty('dispatchRole')
    f.store.close()
    const reopened = f.open()
    expect(reopened.dispatchSetup(project, 'pi')).toEqual(selected)
    expect(reopened.conversationSetup(parent, project, 'pi')).toEqual(selected)
  })

  it('treats explicit no-role as complete and absent legacy fields as incomplete', () => {
    const f = fixture()
    const selected = { ...setup(), role: null }
    f.store.setPreference(project, selected.preference)
    expect(f.store.preference(project, 'pi')).toEqual(selected.preference)
    expect(f.store.dispatchSetup(project, 'pi')).toBeUndefined()
    expect(f.store.conversationSetup(parent, project, 'pi')).toBeUndefined()
    f.store.setDispatchSetup(project, selected)
    f.store.setConversationSetup(parent, project, selected)
    expect(f.store.dispatchSetup(project, 'pi')).toEqual(selected)
    expect(f.store.conversationSetup(parent, project, 'pi')).toEqual(selected)
  })

  it('preserves the legacy Antigravity filename and implicit CLI without migrating on read', () => {
    const f = fixture()
    const legacy = { model: 'legacy-synthetic-model', effort: 'low' as const }
    const file = preferencePath(f.directory, 'antigravity')
    const bytes = JSON.stringify(legacy)
    writeFileSync(file, bytes)
    expect(f.store.preference(project)).toEqual(legacy)
    expect(f.store.dispatchSetup(project, 'antigravity')).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    const selected = { preference: legacy, role: null, binding: 'synthetic-binding' }
    f.store.setDispatchSetup(project, selected)
    f.store.setConversationSetup(parent, project, selected)
    expect(f.store.dispatchSetup(project, 'antigravity')).toEqual(selected)
    expect(f.store.conversationSetup(parent, project, 'antigravity')).toEqual(selected)
  })

  it.each(['role', 'binding'] as const)('does not infer a complete selection from only %s', (field) => {
    const f = fixture()
    const selected = setup()
    writeFileSync(
      preferencePath(f.directory),
      JSON.stringify({
        ...selected.preference,
        ...(field === 'role' ? { dispatchRole: null } : { dispatchBinding: selected.binding }),
      }),
    )
    expect(f.store.preference(project, 'pi')).toEqual(selected.preference)
    expect(f.store.dispatchSetup(project, 'pi')).toBeUndefined()
    f.store.setPreference(project, { ...selected.preference, model: 'updated' })
    expect(f.store.dispatchSetup(project, 'pi')).toBeUndefined()
  })

  it.each([false, true])('settings edits retain role and binding, with no-role=%s', (noRole) => {
    const f = fixture()
    const selected = setup()
    if (noRole) selected.role = null
    f.store.setDispatchSetup(project, selected)
    f.store.setConversationSetup(parent, project, selected)
    const changedPreference = { ...selected.preference, model: 'new-synthetic-model', effort: 'low' as const }
    f.store.setPreference(project, changedPreference)
    expect(f.store.preference(project, 'pi')).toEqual(changedPreference)
    expect(f.store.dispatchSetup(project, 'pi')).toEqual({ ...selected, preference: changedPreference })
    expect(f.store.conversationSetup(parent, project, 'pi')).toEqual(selected)
    expect(f.store.conversationSetup('new-parent', project, 'pi')).toBeUndefined()
  })

  it('freezes selected values independently of caller mutations and role-library edits', () => {
    const f = fixture()
    const selected = setup()
    const preset = f.store.saveRolePreset({ name: '独立角色', summary: '合成说明', prompt: '原提示词' })
    selected.role = { presetId: preset.id, name: preset.name, summary: preset.summary, prompt: preset.prompt }
    const expected = structuredClone(selected)
    f.store.setDispatchSetup(project, selected)
    f.store.setConversationSetup(parent, project, selected)
    selected.role!.prompt = 'changed caller prompt'
    selected.preference.model = 'changed caller model'
    f.store.saveRolePreset({ ...preset, prompt: '新提示词' })
    f.store.deleteRolePreset(preset.id)
    const read = f.store.conversationSetup(parent, project, 'pi')!
    read.role!.prompt = 'changed returned prompt'
    expect(f.store.conversationSetup(parent, project, 'pi')).toEqual(expected)
    expect(f.store.dispatchSetup(project, 'pi')).toEqual(expected)
  })

  it('does not accept private dispatch fields through the public preference setter', () => {
    const f = fixture()
    const selected = setup()
    f.store.setDispatchSetup(project, selected)
    f.store.setPreference(project, {
      ...selected.preference,
      model: 'updated',
      dispatchRole: null,
      dispatchBinding: 'untrusted-binding',
    } as typeof selected.preference)
    expect(f.store.dispatchSetup(project, 'pi')).toEqual({
      ...selected,
      preference: { ...selected.preference, model: 'updated' },
    })
  })

  it('isolates every CLI, project and parent, including OMP and Pi', () => {
    const f = fixture()
    for (const cli of CLI_IDS) {
      const selected = setup(cli)
      selected.preference.model = `synthetic-${cli}`
      f.store.setDispatchSetup(project, selected)
      f.store.setConversationSetup(parent, project, selected)
    }
    for (const cli of CLI_IDS) {
      expect(f.store.dispatchSetup(project, cli)?.preference.model).toBe(`synthetic-${cli}`)
      expect(f.store.conversationSetup(parent, project, cli)?.preference.model).toBe(`synthetic-${cli}`)
      expect(f.store.dispatchSetup('/other-project', cli)).toBeUndefined()
      expect(f.store.conversationSetup('other-parent', project, cli)).toBeUndefined()
      expect(f.store.conversationSetup(parent, '/other-project', cli)).toBeUndefined()
    }
    const other = { ...setup(), role: null, binding: 'synthetic-other-binding' }
    f.store.setDispatchSetup('/other-project', other)
    f.store.setConversationSetup('other-parent', project, other)
    expect(f.store.dispatchSetup(project, 'pi')?.role).not.toBeNull()
    expect(f.store.conversationSetup(parent, project, 'pi')?.role).not.toBeNull()
  })

  it('keeps updated defaults separate from existing conversation snapshots', () => {
    const f = fixture()
    const first = setup()
    f.store.setDispatchSetup(project, first)
    f.store.setConversationSetup(parent, project, first)
    const second = { ...setup(), role: null, binding: 'synthetic-second-binding' }
    f.store.setDispatchSetup(project, second)
    f.store.setConversationSetup('second-parent', project, second)
    expect(f.store.dispatchSetup(project, 'pi')).toEqual(second)
    expect(f.store.conversationSetup(parent, project, 'pi')).toEqual(first)
    expect(f.store.conversationSetup('second-parent', project, 'pi')).toEqual(second)
  })
})

describe('dispatch persistence validation and privacy', () => {
  it.each(['invalid-json', 'invalid-role', 'invalid-binding', 'wrong-cli'])(
    'rejects %s project records without breaking another project or conversation',
    (kind) => {
      const f = fixture()
      const selected = setup()
      f.store.setDispatchSetup(project, selected)
      f.store.setDispatchSetup('/unaffected', selected)
      f.store.setConversationSetup(parent, project, selected)
      const file = preferencePath(f.directory)
      const value = JSON.parse(readFileSync(file, 'utf8'))
      if (kind === 'invalid-role') value.dispatchRole = { name: 'missing prompt' }
      if (kind === 'invalid-binding') value.dispatchBinding = ''
      if (kind === 'wrong-cli') value.cli = 'omp'
      const bytes = kind === 'invalid-json' ? '{' : JSON.stringify(value)
      writeFileSync(file, bytes)
      expect(() => f.store.dispatchSetup(project, 'pi')).toThrow()
      expect(() => f.store.preference(project, 'pi')).toThrow()
      expect(() => f.store.setPreference(project, selected.preference)).toThrow()
      expect(readFileSync(file, 'utf8')).toBe(bytes)
      expect(f.store.dispatchSetup('/unaffected', 'pi')).toEqual(selected)
      expect(f.store.conversationSetup(parent, project, 'pi')).toEqual(selected)
    },
  )

  it.each([
    'invalid-json',
    'missing-role',
    'wrong-parent',
    'wrong-project',
    'wrong-cli',
    'wrong-model-cli',
    'wrong-policy',
  ])('rejects %s conversation records without falling back or touching other records', (kind) => {
    const f = fixture()
    const selected = setup()
    f.store.setDispatchSetup(project, selected)
    f.store.setConversationSetup(parent, project, selected)
    f.store.setConversationSetup('unaffected-parent', project, selected)
    const file = conversationPath(f.directory)
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (kind === 'missing-role') delete value.setup.role
    if (kind === 'wrong-parent') value.parent = 'other-parent'
    if (kind === 'wrong-project') value.project = '/other-project'
    if (kind === 'wrong-cli') value.cli = 'omp'
    if (kind === 'wrong-model-cli') value.setup.preference.cli = 'omp'
    if (kind === 'wrong-policy') value.policy = 2
    const bytes = kind === 'invalid-json' ? '{' : JSON.stringify(value)
    writeFileSync(file, bytes)
    expect(() => f.store.conversationSetup(parent, project, 'pi')).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(f.store.conversationSetup('unaffected-parent', project, 'pi')).toEqual(selected)
    expect(f.store.dispatchSetup(project, 'pi')).toEqual(selected)
  })

  it('rejects a valid record copied into another parent namespace', () => {
    const f = fixture()
    f.store.setConversationSetup(parent, project, setup())
    copyFileSync(conversationPath(f.directory), conversationPath(f.directory, 'other-parent'))
    expect(() => f.store.conversationSetup('other-parent', project, 'pi')).toThrow('身份不匹配')
  })

  it('validates complete writes before replacing existing records', () => {
    const f = fixture()
    const selected = setup()
    f.store.setDispatchSetup(project, selected)
    f.store.setConversationSetup(parent, project, selected)
    for (const invalid of [
      { ...selected, role: undefined },
      { ...selected, binding: '' },
      { ...selected, binding: 'x'.repeat(257) },
      { ...selected, preference: { ...selected.preference, effort: 'invented' } },
    ]) {
      expect(() => f.store.setDispatchSetup(project, invalid as DispatchSetup)).toThrow()
      expect(() => f.store.setConversationSetup(parent, project, invalid as DispatchSetup)).toThrow()
    }
    expect(f.store.dispatchSetup(project, 'pi')).toEqual(selected)
    expect(f.store.conversationSetup(parent, project, 'pi')).toEqual(selected)
  })

  it('cannot revive the retired Harness identity or accept missing storage identities', () => {
    const f = fixture()
    expect(f.store.dispatchSetup(project, 'harness')).toBeUndefined()
    expect(f.store.conversationSetup(parent, project, 'harness')).toBeUndefined()
    expect(() => f.store.setDispatchSetup(project, setup('harness'))).toThrow('入口已移除')
    expect(() => f.store.setConversationSetup(parent, project, setup('harness'))).toThrow('入口已移除')
    expect(() => f.store.setDispatchSetup('', setup())).toThrow()
    expect(() => f.store.setConversationSetup('', project, setup())).toThrow()
    expect(() => f.store.setConversationSetup(parent, '', setup())).toThrow()
  })

  it('uses private files with hashed names and leaves no temporary files after replacement', () => {
    const f = fixture()
    const unusualParent = '../../synthetic-parent'
    const unusualProject = '/synthetic/project with spaces/../other'
    f.store.setDispatchSetup(unusualProject, setup())
    f.store.setConversationSetup(unusualParent, unusualProject, setup())
    const files = readdirSync(f.directory).filter((file) =>
      /\.(preference|conversation-setup)\.json$/.test(file),
    )
    expect(files).toHaveLength(2)
    for (const file of files) expect(file).toMatch(/^[0-9a-f]{64}\.(preference|conversation-setup)\.json$/)
    if (process.platform !== 'win32') {
      expect(statSync(f.directory).mode & 0o777).toBe(0o700)
      for (const file of files) {
        expect(statSync(join(f.directory, file)).mode & 0o777).toBe(0o600)
        chmodSync(join(f.directory, file), 0o644)
      }
    }
    f.store.setPreference(unusualProject, { ...setup().preference, model: 'updated' })
    f.store.setConversationSetup(unusualParent, unusualProject, { ...setup(), role: null })
    if (process.platform !== 'win32')
      for (const file of files) expect(statSync(join(f.directory, file)).mode & 0o777).toBe(0o600)
    expect(readdirSync(f.directory).some((file) => file.endsWith('.tmp'))).toBe(false)
  })

  it('cleans its private temporary file when atomic replacement fails', () => {
    const f = fixture()
    const blocked = conversationPath(f.directory)
    mkdirSync(blocked)
    expect(() => f.store.setConversationSetup(parent, project, setup())).toThrow()
    expect(existsSync(blocked)).toBe(true)
    expect(readdirSync(f.directory).some((file) => file.endsWith('.tmp'))).toBe(false)
    expect(f.store.dispatchSetup(project, 'pi')).toBeUndefined()
  })
})
