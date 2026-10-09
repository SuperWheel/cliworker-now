import { expect, it, vi } from 'vitest'
import { CliWorkerService } from '../src/host/index.ts'
import type { DispatchSetup } from '../src/host/storage.ts'

// Real registered tool entry; complete setup and publication are synthetic.
// Complete question, cancellation and storage coverage lives in dispatch-flow.test.ts.
function setup() {
  const tools = new Map<string, any>()
  let answer!: (response: DispatchSetup) => void
  const waiting = new Promise<DispatchSetup>((resolve) => {
    answer = resolve
  })
  const chooseDispatch = vi.fn(() => waiting)
  const launch = vi.fn((..._args: unknown[]) => 'synthetic-receipt')
  const service: any = {
    ctx: {
      effect: (register: () => unknown) => register(),
      tools: { register: (definition: any) => tools.set(definition.name, definition) },
    },
    assertExecution: vi.fn(),
    chooseDispatch,
    disposed: new AbortController(),
    launch,
  }
  ;(CliWorkerService.prototype as any).registerTools.call(service)
  const controller = new AbortController(),
    agent = { id: 'synthetic-parent' }
  const start = () =>
    tools
      .get('cliworker_start')
      .execute(
        { cli: 'antigravity', title: '测试', prompt: '合成任务', agent_name: '小林' },
        { agent, signal: controller.signal },
      )
  const selected: DispatchSetup = {
    preference: { cli: 'antigravity', model: 'fixture', effort: 'low' },
    role: { presetId: 'fixture-review', name: '审稿员', summary: '合成角色', prompt: '检查证据' },
    binding: 'synthetic-account',
  }
  return { service, chooseDispatch, launch, answer, controller, start, selected }
}

it('publishes only after the complete setup and passes the frozen role without another question', async () => {
  const f = setup(),
    pending = f.start()
  await Promise.resolve()
  expect(f.chooseDispatch).toHaveBeenCalledTimes(1)
  expect(f.launch).not.toHaveBeenCalled()
  f.answer(f.selected)
  expect(await pending).toBe('synthetic-receipt')
  expect(f.launch.mock.calls[0]![3]).toEqual(f.selected.preference)
  expect(f.launch.mock.calls[0]![6]).toMatchObject({ agentName: '小林', role: f.selected.role })
})
it('cancellation before complete setup returns never publishes a background job', async () => {
  const f = setup(),
    pending = f.start()
  f.controller.abort(new Error('user cancelled'))
  f.answer(f.selected)
  await expect(pending).rejects.toThrow('user cancelled')
  expect(f.launch).not.toHaveBeenCalled()
})
it('explicit no-role setup starts without substituting any preset', async () => {
  const f = setup(),
    pending = f.start()
  f.answer({ ...f.selected, role: null })
  await pending
  expect(f.launch.mock.calls[0]![6]).toEqual({ agentName: '小林', role: undefined })
})
