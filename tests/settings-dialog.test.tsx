import { createElement, forwardRef, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsDialog } from '../src/client/settings-dialog.tsx'
import type { API } from '../src/client/workers.ts'
import type { AccountStatus } from '../src/shared/accounts.ts'
import type { CliId } from '../src/shared/types.ts'

// Explicit simulation: no CLI, login flow or native portal is started in these tests.
const terminal = vi.hoisted(() => ({ started: vi.fn(), stopped: vi.fn() }))
vi.mock('../src/client/account-terminal.tsx', () => ({
  AccountTerminal: ({ cli, action, onClose, onFinished }: any) => {
    useEffect(() => {
      terminal.started(cli, action)
      return () => terminal.stopped(cli, action)
    }, [cli, action])
    return createElement(
      'div',
      { 'data-terminal': cli },
      createElement('button', { onClick: onClose }, '关闭模拟账号操作'),
      createElement('button', { onClick: onFinished }, '完成模拟账号操作'),
    )
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Modal: ({ open, title, children, onClose, closeLabel }: any) =>
    open
      ? createElement(
          'section',
          { role: 'dialog', 'aria-label': title },
          createElement('button', { 'aria-label': closeLabel, onClick: onClose }, closeLabel),
          children,
        )
      : null,
  StateDot: () => createElement('svg', { 'data-loading': true }),
  Tooltip: ({ children }: any) => children,
  IconSettingsOutlineRegular: () => createElement('svg'),
  IconCopyOutlineRegular: () => createElement('svg'),
  IconChevronDownOutlineRegular: () => createElement('svg'),
  Menu: ({ anchor, open, items = [], onSelect }: any) =>
    createElement(
      'div',
      {},
      anchor,
      open &&
        createElement(
          'div',
          { role: 'menu' },
          items.map((item: any) =>
            createElement('button', { key: item.id, onClick: () => onSelect(item.id) }, item.label),
          ),
        ),
    ),
  Button: forwardRef(({ children, variant: _variant, size: _size, ...props }: any, ref) =>
    createElement('button', { type: 'button', ...props, ref }, children),
  ),
}))
const mounted: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount()
  })
  vi.clearAllMocks()
})
function deferred() {
  let resolve!: (value: any) => void, reject!: (reason: unknown) => void
  const promise = new Promise<any>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const remote = (data: unknown) => ({ ok: true, value: JSON.stringify(data) })
const catalog = (cli: CliId, model = `${cli}-fixture`) =>
  remote({ cli, models: [{ id: model, efforts: ['low', 'high'] }] })
const status = (cli: CliId, changes: Partial<AccountStatus> = {}) =>
  remote({
    cli,
    installed: true,
    state: 'unknown',
    summary: `${cli} 模拟状态待确认`,
    actions: [],
    ...changes,
  })
async function setup(overrides: Record<string, any> = {}) {
  const catalogForCli = vi.fn(async (_session, cli: CliId) => catalog(cli))
  const accountStatus = vi.fn(async (_session, cli: CliId) => status(cli))
  const configure = vi.fn().mockResolvedValue(remote({}))
  const api = { cliworker: { catalogForCli, accountStatus, configure, ...overrides } } as unknown as API
  let r!: ReactTestRenderer
  const render = (open: boolean) => (
    <SettingsDialog
      open={open}
      onClose={() => r.update(render(false))}
      api={api}
      sessionId="simulation-parent"
      initialCli="antigravity"
    />
  )
  await act(async () => {
    r = create(render(true))
    mounted.push(r)
  })
  const text = () => JSON.stringify(r.toJSON())
  const button = (label: string) =>
    r.root.findAllByType('button').find((b) => b.props['aria-label'] === label || b.children.includes(label))!
  const click = async (label: string) => {
    await act(async () => button(label).props.onClick())
  }
  const open = async () => {
    await act(async () => r.update(render(true)))
  }
  const submit = async () => {
    await act(async () =>
      r.root.findByProps({ className: 'cwn-settings-form' }).props.onSubmit({ preventDefault() {} }),
    )
  }
  return { r, text, button, click, open, submit, api, configure, accountStatus, catalogForCli }
}
it('keeps CLI navigation and dismissal available while account and model discovery are delayed', async () => {
  const models = deferred(),
    account = deferred()
  const t = await setup({
    catalogForCli: vi.fn((_session, cli) =>
      cli === 'antigravity' ? models.promise : Promise.resolve(catalog(cli)),
    ),
    accountStatus: vi.fn((_session, cli) =>
      cli === 'antigravity' ? account.promise : Promise.resolve(status(cli)),
    ),
  })
  expect(t.text()).toContain('正在读取 Antigravity 模型')
  expect(t.text()).toContain('正在读取 Antigravity 账号')
  expect(t.button('保存默认值').props.disabled).toBe(true)
  expect(t.button('Codex 设置').props.disabled).not.toBe(true)
  expect(t.button('关闭设置').props.disabled).not.toBe(true)
  await t.click('Codex 设置')
  expect(t.text()).toContain('codex-fixture')
  await act(async () => {
    models.resolve(catalog('antigravity', 'stale-model'))
    account.resolve(status('antigravity', { summary: 'stale-account' }))
  })
  expect(t.text()).not.toContain('stale-model')
  expect(t.text()).not.toContain('stale-account')
  await t.click('关闭设置')
  expect(t.r.toJSON()).toBe(null)
})
it('ignores a request from a previous dialog instance after closing and reopening', async () => {
  const old = deferred()
  const t = await setup({
    catalogForCli: vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(catalog('antigravity', 'fresh-model')),
  })
  await t.click('关闭设置')
  await t.open()
  expect(t.text()).toContain('fresh-model')
  await act(async () => old.resolve(catalog('antigravity', 'old-model')))
  expect(t.text()).not.toContain('old-model')
  expect(t.text()).toContain('fresh-model')
})
it('lets model defaults work independently when account discovery fails', async () => {
  const t = await setup({ accountStatus: vi.fn().mockRejectedValue(new Error('模拟账号查询失败')) })
  expect(t.text()).toContain('模拟账号查询失败')
  expect(t.button('保存默认值').props.disabled).toBe(false)
  await t.submit()
  expect(JSON.parse(t.configure.mock.calls[0]![1])).toEqual({
    cli: 'antigravity',
    model: 'antigravity-fixture',
    effort: 'low',
  })
  expect(t.text()).toContain('默认设置已保存')
})
it('never treats unknown account status as logged out or mounts a terminal without an explicit action', async () => {
  const t = await setup({
    accountStatus: vi.fn(async (_parent, cli: CliId) =>
      status(cli, {
        summary: '模拟状态无法确认',
        actions: [{ id: 'manage', label: '模拟管理账号', description: '由模拟 Host 提供' }],
      }),
    ),
  })
  expect(t.text()).toContain('模拟状态无法确认')
  expect(t.text()).not.toContain('未登录')
  expect(t.button('登录')).toBeUndefined()
  expect(terminal.started).not.toHaveBeenCalled()
  await t.click('模拟管理账号')
  expect(terminal.started).toHaveBeenCalledExactlyOnceWith('antigravity', 'manage')
  await t.click('Codex 设置')
  expect(terminal.stopped).toHaveBeenCalledExactlyOnceWith('antigravity', 'manage')
  expect(terminal.started).toHaveBeenCalledTimes(1)
})
it('keeps a delayed save scoped to its original CLI and leaves navigation usable', async () => {
  const saved = deferred()
  const t = await setup({ configure: vi.fn().mockReturnValue(saved.promise) })
  await t.submit()
  expect(t.text()).toContain('data-loading')
  expect(t.button('Kimi 设置').props.disabled).not.toBe(true)
  await t.click('Kimi 设置')
  await act(async () => saved.reject(new Error('stale save failure')))
  expect(t.text()).not.toContain('stale save failure')
  expect(t.text()).not.toContain('默认设置已保存')
  expect(t.text()).toContain('kimi-fixture')
})
it('refreshes real capability data after a user-operated account flow finishes', async () => {
  const accountStatus = vi.fn(async (_parent, cli: CliId) =>
    status(cli, { actions: [{ id: 'login', label: '模拟登录', description: '模拟' }] }),
  )
  const t = await setup({ accountStatus })
  await t.click('模拟登录')
  await t.click('完成模拟账号操作')
  expect(accountStatus).toHaveBeenCalledTimes(2)
  expect(t.catalogForCli).toHaveBeenCalledTimes(2)
  await t.click('关闭设置')
  expect(terminal.stopped).toHaveBeenCalledExactlyOnceWith('antigravity', 'login')
})

it('uses Kimi supported default effort without a saved preference and can persist it', async () => {
  const t = await setup({
    catalogForCli: vi.fn(async (_parent, cli: CliId) =>
      cli === 'kimi'
        ? remote({ cli, models: [{ id: 'kimi-simulation', efforts: ['default'] }] })
        : catalog(cli),
    ),
  })
  await t.click('Kimi 设置')
  expect(t.text()).toContain('kimi-simulation')
  expect(t.text()).toContain('沿用 CLI 配置')
  expect(t.button('保存默认值').props.disabled).toBe(false)
  await t.click('默认思考强度')
  expect(
    t.r.root
      .findAllByProps({ role: 'menu' })[0]!
      .findAllByType('button')
      .map((item) => item.children.join('')),
  ).toEqual(['沿用 CLI 配置'])
  await t.click('沿用 CLI 配置')
  await t.submit()
  expect(JSON.parse(t.configure.mock.calls[0]![1])).toEqual({
    cli: 'kimi',
    model: 'kimi-simulation',
    effort: 'default',
  })
  expect(t.text()).toContain('默认设置已保存')
})
