import { createElement, forwardRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { RolePresetsPane } from '../src/client/role-presets.tsx'
import { RenameWorker } from '../src/client/rename-worker.tsx'
import type { API } from '../src/client/workers.ts'
import type { RolePreset, Worker } from '../src/shared/types.ts'

// Simulated RPC responses exercise form/state behavior; no CLI task is launched.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: forwardRef(({ children, variant: _variant, size: _size, ...props }: any, ref) =>
    createElement('button', { ...props, ref }, children),
  ),
  Input: forwardRef(({ icon, ...props }: any, ref) =>
    createElement('span', {}, icon, createElement('input', { ...props, ref })),
  ),
  StateDot: () => createElement('span', { 'data-loading': true }),
  Modal: ({ children, title }: any) =>
    createElement('section', { role: 'dialog', 'aria-label': title }, children),
  IconSettingsOutlineRegular: () => createElement('svg'),
  IconCopyOutlineRegular: () => createElement('svg'),
}))
const mounted: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount()
  })
})
const fixture: RolePreset = {
  id: 'logic-fixture',
  name: '逻辑审稿人',
  summary: '核对人物行动与因果链',
  prompt: '模拟角色提示词：只检查因果，不改写正文。',
  builtin: true,
}
const remote = (value: unknown) => ({ ok: true, value: JSON.stringify(value) })
function controls(r: ReactTestRenderer) {
  const button = (label: string) =>
    r.root.findAllByType('button').find((b) => b.props['aria-label'] === label || b.children.includes(label))!
  return {
    button,
    click: async (label: string) => {
      await act(async () => button(label).props.onClick())
    },
    edit: async (label: string, text: string) => {
      await act(async () =>
        r.root
          .findAll(
            (n) => ['input', 'textarea'].includes(String(n.type)) && n.props['aria-label'] === label,
          )[0]
          .props.onChange({ target: { value: text } }),
      )
    },
    submit: async () => {
      await act(async () => r.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    },
    text: () => JSON.stringify(r.toJSON()),
  }
}
async function setup(overrides: Record<string, unknown> = {}) {
  const rolePresets = vi.fn(async () => remote([fixture]))
  const saveRolePreset = vi.fn(async (_session, raw) => remote({ id: 'new-fixture', ...JSON.parse(raw) }))
  const deleteRolePreset = vi.fn(async () => ({ ok: true, value: undefined }))
  const api = { cliworker: { rolePresets, saveRolePreset, deleteRolePreset, ...overrides } } as unknown as API
  let r!: ReactTestRenderer
  await act(async () => {
    r = create(<RolePresetsPane api={api} sessionId="parent-fixture" />)
    mounted.push(r)
  })
  return { r, ...controls(r), rolePresets, saveRolePreset, deleteRolePreset }
}
it('searches the role library and opens a built-in prompt for editing', async () => {
  const t = await setup()
  expect(t.text()).toContain(fixture.summary)
  await t.edit('搜索智能体预设', '不存在')
  expect(t.text()).toContain('没有匹配的预设')
  await t.edit('搜索智能体预设', '因果')
  await t.click('编辑预设 逻辑审稿人')
  expect(t.r.root.findByType('textarea').props.value).toBe(fixture.prompt)
  await t.edit('角色提示词', '新的模拟职责')
  await t.submit()
  expect(JSON.parse(t.saveRolePreset.mock.calls[0][1])).toMatchObject({
    id: fixture.id,
    prompt: '新的模拟职责',
  })
  expect(t.text()).toContain('预设已保存')
})
it('validates a custom preset before saving and preserves the draft after a failed save', async () => {
  const saveRolePreset = vi.fn().mockResolvedValue({ ok: false, error: { message: '模拟保存失败' } })
  const t = await setup({ saveRolePreset })
  await t.click('新增预设')
  await t.submit()
  expect(saveRolePreset).not.toHaveBeenCalled()
  expect(t.text()).toContain('请填写智能体名称')
  await t.edit('智能体名称', '节奏教练')
  await t.edit('智能体概述', '检查节奏')
  await t.edit('角色提示词', '模拟：只读检查章节节奏。')
  await t.submit()
  expect(saveRolePreset).toHaveBeenCalledTimes(1)
  expect(t.r.root.findByType('textarea').props.value).toBe('模拟：只读检查章节节奏。')
  expect(t.text()).toContain('模拟保存失败')
})
it('confirms deletion and removes only the selected preset without changing worker data', async () => {
  const t = await setup()
  await t.click('编辑预设 逻辑审稿人')
  await t.click('删除预设')
  expect(t.deleteRolePreset).not.toHaveBeenCalled()
  expect(t.text()).toContain('已有智能体仍保留原角色')
  await t.click('确认删除')
  expect(t.deleteRolePreset.mock.calls[0].slice(0, 2)).toEqual(['parent-fixture', fixture.id])
  expect(t.text()).toContain('还没有预设')
})
it('keeps the loading shell available and aborts discovery when the pane closes', async () => {
  let signal: AbortSignal | undefined
  const t = await setup({
    rolePresets: vi.fn((_session, nextSignal) => {
      signal = nextSignal
      return new Promise(() => {})
    }),
  })
  expect(t.text()).toContain('正在同步智能体预设')
  expect(t.button('新增预设').props.disabled).toBe(true)
  await t.edit('搜索智能体预设', '可继续输入')
  await act(async () => t.r.unmount())
  expect(signal?.aborted).toBe(true)
})
it('renames through its owning parent session and keeps a conflicting name editable', async () => {
  const renameWorker = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, error: { message: '同名智能体已存在' } })
    .mockResolvedValue({ ok: true, value: undefined })
  const onClose = vi.fn()
  const api = { cliworker: { renameWorker } } as unknown as API
  const worker = { id: 'worker-fixture', agentName: '逻辑审稿人-1' } as Worker
  let r!: ReactTestRenderer
  await act(async () => {
    r = create(<RenameWorker api={api} sessionId="parent-fixture" worker={worker} onClose={onClose} />)
    mounted.push(r)
  })
  const t = controls(r)
  await t.edit('新的智能体名称', '审稿人')
  await t.submit()
  expect(t.text()).toContain('同名智能体已存在')
  expect(onClose).not.toHaveBeenCalled()
  await t.edit('新的智能体名称', '因果审稿人')
  await t.submit()
  expect(renameWorker.mock.calls[1].slice(0, 3)).toEqual(['parent-fixture', 'worker-fixture', '因果审稿人'])
  expect(onClose).toHaveBeenCalledOnce()
})
