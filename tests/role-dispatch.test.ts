import { expect, it, vi } from 'vitest'
import { CliWorkerService } from '../src/host/index.ts'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'

// Native tool definitions and role question lifecycle are real. Model discovery,
// already-saved preferences, and publication are synthetic; no CLI is launched.
function setup() {
  const tools = new Map<string, any>()
  let answer!: (response: AskUserQuestionAnswer) => void
  const waiting = new Promise<AskUserQuestionAnswer>((resolve) => {
    answer = resolve
  })
  const ask = vi.fn((_request: unknown) => waiting)
  const launch = vi.fn((..._args: unknown[]) => 'synthetic-receipt')
  const service: any = {
    ctx: {
      effect: (register: () => unknown) => register(),
      tools: {
        register: (definition: any) => {
          tools.set(definition.name, definition)
        },
      },
    },
    assertExecution: vi.fn(),
    choose: vi.fn(async () => ({ cli: 'antigravity', model: 'saved-model', effort: 'low' })),
    chooseRole: (CliWorkerService.prototype as any).chooseRole,
    disposed: new AbortController(),
    pending: new Map(),
    runtime: {
      changed: vi.fn(),
      storage: {
        rolePresets: () => [
          { id: 'fixture-review', name: '审稿员', summary: '合成角色', prompt: '检查证据' },
        ],
      },
    },
    launch,
  }
  ;(CliWorkerService.prototype as any).registerTools.call(service)
  const controller = new AbortController()
  const agent = {
    id: 'synthetic-parent',
    ctx: { get: (name: string) => (name === 'userQuestions' ? { ask } : undefined) },
  }
  const start = () =>
    tools
      .get('cliworker_start')
      .execute(
        { cli: 'antigravity', title: '测试', prompt: '合成任务', agent_name: '小林' },
        { agent, signal: controller.signal },
      )
  return { service, ask, launch, answer, controller, start }
}

it('asks a role question even with saved model defaults and publishes only after the human selects', async () => {
  const f = setup()
  const running = f.start()
  await Promise.resolve()
  expect(f.ask).toHaveBeenCalledTimes(1)
  expect(f.ask.mock.calls[0]![0]).toMatchObject({ questions: [{ id: 'cliworker_role' }] })
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.service.pending.has('synthetic-parent')).toBe(true)
  f.answer({ answers: [{ id: 'cliworker_role', selected: ['审稿员'] }] })
  expect(await running).toBe('synthetic-receipt')
  expect(f.launch.mock.calls[0]![6]).toMatchObject({
    agentName: '小林',
    role: { presetId: 'fixture-review', prompt: '检查证据' },
  })
  expect(f.service.pending.size).toBe(0)
})

it('cancelling or skipping the role question never publishes a background job', async () => {
  const cancelled = setup()
  const running = cancelled.start()
  await Promise.resolve()
  cancelled.controller.abort(new Error('user cancelled'))
  cancelled.answer({ answers: [{ id: 'cliworker_role', selected: ['审稿员'] }] })
  await expect(running).rejects.toThrow('user cancelled')
  expect(cancelled.launch).not.toHaveBeenCalled()
  expect(cancelled.service.pending.size).toBe(0)
  const skipped = setup()
  const pending = skipped.start()
  await Promise.resolve()
  skipped.answer({ answers: [{ id: 'cliworker_role', selected: [] }] })
  await expect(pending).rejects.toThrow('尚未启动')
  expect(skipped.launch).not.toHaveBeenCalled()
})
