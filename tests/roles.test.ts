import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { WorkerStorage } from '../src/host/storage.ts'
import { WorkerRuntime } from '../src/host/runtime.ts'
import { DEFAULT_CONFIG, type ProcessBackend } from '../src/host/process.ts'
import { askRolePreset, NO_ROLE_LABEL, roleSnapshot } from '../src/host/roles.ts'
import { workerName, type RolePreset } from '../src/shared/types.ts'
import { BUILTIN_ROLE_PRESETS } from '../src/shared/builtin-presets.ts'

// Entirely synthetic roles, process streams, and state directories. No model invocation.
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const fixtureRole: RolePreset = {
  id: 'reviewer',
  name: '逻辑审稿',
  summary: '检查因果关系',
  prompt: '只报告有证据的逻辑矛盾。',
}
const preference = { model: 'fixture-model', effort: 'low' as const }
const signal = () => new AbortController().signal

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cwn-roles-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  mkdirSync(project)
  const storage = new WorkerStorage(join(root, 'state'))
  const calls: { spec: SubprocessSpawnSpec; finish: (conversationId: string) => void }[] = []
  const backend: ProcessBackend = {
    resolveExecutable: async () => '/synthetic/agy',
    spawn: (spec) => {
      const stdout = new PassThrough(),
        stderr = new PassThrough()
      let resolve!: (outcome: { exitCode: number }) => void
      const done = new Promise<{ exitCode: number }>((settle) => {
        resolve = settle
      })
      const end = (exitCode: number) => {
        stdout.end()
        stderr.end()
        resolve({ exitCode })
      }
      const terminate = () => end(143)
      calls.push({
        spec,
        finish: (conversationId) => {
          stdout.write(
            JSON.stringify({
              event: 'result',
              result: { conversation_id: conversationId, status: 'SUCCESS', response: 'Synthetic answer' },
            }) + '\n',
          )
          end(0)
        },
      })
      spec.signal?.addEventListener('abort', terminate)
      return {
        stdout,
        stderr,
        done,
        terminate,
        waitForExit: async () => {
          await done
          return true
        },
      } as SubprocessHandle
    },
  }
  const runtime = new WorkerRuntime(storage, backend, DEFAULT_CONFIG)
  cleanups.push(() => runtime.close())
  return { root, project, storage, runtime, calls }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('editable role library', () => {
  it('seeds the seven imported roles once, preserves edits/deletions on reopen, and stores privately', () => {
    const { root, storage } = setup()
    expect(storage.rolePresets()).toHaveLength(7)
    expect(storage.rolePresets().map((preset) => preset.id)).toEqual(
      BUILTIN_ROLE_PRESETS.map((preset) => preset.id),
    )
    const first = storage.rolePresets()[0]!
    storage.saveRolePreset({ ...first, prompt: '用户修改后的角色提示词' })
    const deleted = storage.rolePresets()[1]!.id
    storage.deleteRolePreset(deleted)
    storage.close()
    const reopened = new WorkerStorage(join(root, 'state'))
    cleanups.push(() => reopened.close())
    expect(reopened.rolePresets().find((preset) => preset.id === first.id)?.prompt).toBe(
      '用户修改后的角色提示词',
    )
    expect(reopened.rolePresets().some((preset) => preset.id === deleted)).toBe(false)
    expect(statSync(join(root, 'state', 'role-presets.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o700)
    const detached = reopened.rolePresets()
    detached[0]!.prompt = 'must not mutate stored role'
    expect(reopened.rolePresets()[0]!.prompt).toBe('用户修改后的角色提示词')
  })
  it('validates editable data and refuses stale IDs and duplicate names instead of overwriting another role', () => {
    const { storage } = setup()
    const saved = storage.saveRolePreset({
      name: '  临时书评员  ',
      summary: '  合成测试  ',
      prompt: '  根据证据审查  ',
    })
    expect(saved).toMatchObject({ name: '临时书评员', summary: '合成测试', prompt: '根据证据审查' })
    expect(() => storage.saveRolePreset({ ...saved, id: undefined })).toThrow('名称已被使用')
    expect(() => storage.saveRolePreset({ ...saved, prompt: '  ' })).toThrow()
    expect(() => storage.saveRolePreset({ ...saved, name: '分行\n名称' })).toThrow()
    expect(() => storage.saveRolePreset({ ...saved, id: undefined, name: NO_ROLE_LABEL })).toThrow()
    storage.deleteRolePreset(saved.id)
    expect(() => storage.saveRolePreset(saved)).toThrow('已删除')
  })
})

describe('role selection in complete dispatch setup', () => {
  it('requires an explicit role/no-role response and treats native Other as a temporary snapshot', async () => {
    const ask = vi.fn(async () => ({ answers: [{ id: 'cliworker_role', selected: [fixtureRole.name] }] }))
    const role = await askRolePreset([fixtureRole], ask, signal())
    expect(role).toEqual(roleSnapshot(fixtureRole))
    expect(ask.mock.calls).toHaveLength(1)
    await expect(askRolePreset([fixtureRole], async () => ({ answers: [] }), signal())).rejects.toThrow(
      '尚未启动',
    )
    expect(
      await askRolePreset(
        [fixtureRole],
        async () => ({ answers: [{ id: 'cliworker_role', selected: [NO_ROLE_LABEL] }] }),
        signal(),
      ),
    ).toBeUndefined()
    expect(
      await askRolePreset(
        [fixtureRole],
        async () => ({ answers: [{ id: 'cliworker_role', selected: [], custom: '仅检查对话节奏' }] }),
        signal(),
      ),
    ).toEqual({ name: '临时角色', summary: '本次派遣自定义的角色提示词', prompt: '仅检查对话节奏' })
  })
  it('does not accept an answer after cancellation or silently use a newly edited preset', async () => {
    const controller = new AbortController()
    await expect(
      askRolePreset(
        [fixtureRole],
        async () => {
          controller.abort(new Error('已取消'))
          return { answers: [{ id: 'cliworker_role', selected: [fixtureRole.name] }] }
        },
        controller.signal,
      ),
    ).rejects.toThrow('已取消')
    const editing = structuredClone(fixtureRole)
    const role = await askRolePreset(
      [editing],
      async () => {
        editing.prompt = '用户同时编辑了另一版本'
        return { answers: [{ id: 'cliworker_role', selected: [editing.name] }] }
      },
      signal(),
    )
    expect(role?.prompt).toBe(fixtureRole.prompt)
  })
})

describe('named conversations and frozen roles', () => {
  it('injects a frozen role only into initial CLI input, keeps clean events, and preserves it across library deletion and followup', async () => {
    const { storage, runtime, project, calls } = setup()
    const preset = storage.saveRolePreset({
      name: fixtureRole.name,
      summary: fixtureRole.summary,
      prompt: fixtureRole.prompt,
    })
    const role = roleSnapshot(preset)
    const initial = runtime.submit(
      'parent',
      project,
      '章节测试',
      '请检查第八章',
      preference,
      'accept-edits',
      undefined,
      { role },
    )
    role.prompt = 'external mutation must not reach worker'
    expect(initial.worker.agentName).toBe('agy-1')
    expect(storage.history(initial.worker.id)[0]?.text).toBe('请检查第八章')
    storage.saveRolePreset({ ...preset, prompt: '后续修改' })
    storage.deleteRolePreset(preset.id)
    await tick()
    expect(calls[0]!.spec.argv.some((arg) => arg.includes(fixtureRole.prompt))).toBe(true)
    expect(calls[0]!.spec.argv.some((arg) => arg.includes('请检查第八章'))).toBe(true)
    calls[0]!.finish('synthetic-original-conversation')
    expect((await initial.done).status).toBe('completed')
    const followup = runtime.submit(
      'parent',
      project,
      'ignored',
      '继续检查第九章',
      preference,
      'accept-edits',
      initial.worker.id,
    )
    await tick()
    expect(calls[1]!.spec.argv).toContain('任务：\n继续检查第九章')
    expect(calls[1]!.spec.argv.some((arg) => arg.includes(fixtureRole.prompt))).toBe(false)
    expect(followup.worker.role?.prompt).toBe(fixtureRole.prompt)
    expect(followup.worker.agentName).toBe('agy-1')
    calls[1]!.finish('synthetic-original-conversation')
    await followup.done
    const persisted = JSON.parse(
      readFileSync(join(storage.directory, `${initial.worker.id}.worker.json`), 'utf8'),
    )
    expect(persisted.role.prompt).toBe(fixtureRole.prompt)
  })
  it('uniquely names, renames and resolves workers in one parent without crossing ownership', async () => {
    const { runtime, project, storage } = setup()
    const first = runtime.submit('parent', project, 'A', 'task', preference, 'accept-edits', undefined, {
      role: roleSnapshot(fixtureRole),
    })
    const second = runtime.submit('parent', project, 'B', 'task', preference, 'accept-edits', undefined, {
      role: roleSnapshot(fixtureRole),
    })
    expect(second.worker.agentName).toBe('agy-2')
    expect(runtime.resolveWorker('parent', undefined, 'agy-1').id).toBe(first.worker.id)
    expect(() => runtime.resolveWorker('other-parent', first.worker.id)).toThrow('does not belong')
    expect(() => runtime.resolveWorker('other-parent', undefined, 'agy-1')).toThrow('没有此名称')
    expect(() => runtime.resolveWorker('parent', first.worker.id, 'agy-2')).toThrow('不匹配')
    expect(() => runtime.renameWorker('parent', second.worker.id, 'agy-1')).toThrow('同名')
    runtime.renameWorker('parent', first.worker.id, '小林')
    expect(runtime.resolveWorker('parent', undefined, '小林').id).toBe(first.worker.id)
    expect(() => runtime.resolveWorker('parent', undefined, 'agy-1')).toThrow('没有此名称')
    expect(() => runtime.renameWorker('other-parent', first.worker.id, '小李')).toThrow('does not belong')
    const save = vi.spyOn(storage, 'save').mockImplementationOnce(() => {
      throw new Error('Synthetic disk failure')
    })
    expect(() => runtime.renameWorker('parent', first.worker.id, '未保存的新名')).toThrow(
      'Synthetic disk failure',
    )
    expect(runtime.resolveWorker('parent', undefined, '小林').id).toBe(first.worker.id)
    expect(first.worker.agentName).toBe('小林')
    save.mockRestore()
    delete second.worker.agentName
    storage.save(second.worker)
    expect(runtime.resolveWorker('parent', undefined, workerName(second.worker)).id).toBe(second.worker.id)
    // A malformed old store with duplicate names is surfaced instead of choosing arbitrarily.
    second.worker.agentName = first.worker.agentName
    storage.save(second.worker)
    expect(() => runtime.resolveWorker('parent', undefined, '小林')).toThrow('不唯一')
    await runtime.stop('parent', first.worker.id)
    await runtime.stop('parent', second.worker.id)
  })
})

// Synthetic authorization fixture for lifecycle/protocol tests; own-account rules
// are exercised separately by authorized-catalog and runtime-account-isolation.
vi.mock('../src/host/cli-account-binding.ts', () => ({
  readCliAccountBinding: async () => 'synthetic-own-account',
}))
vi.mock('../src/host/authorized-catalog.ts', () => ({
  ACCOUNT_CHANGED: '账号已变更，请重新选择或新建任务',
  authorizeSelection: async (preference: unknown) => ({ binding: 'synthetic-own-account', preference }),
}))
