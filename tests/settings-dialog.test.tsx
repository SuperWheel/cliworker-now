import { createElement, forwardRef, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsDialog } from '../src/client/settings-dialog.tsx'
import type { API } from '../src/client/workers.ts'
import type { AccountStatus } from '../src/shared/accounts.ts'
import { CLI_IDS, CLI_LABELS, type CliId } from '../src/shared/types.ts'

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
  Switch: ({ checked, onChange, label, disabled }: any) =>
    createElement('button', {
      role: 'switch',
      'aria-label': label,
      'aria-checked': checked,
      disabled,
      onClick: () => onChange(!checked),
    }),
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
  let enabled = Object.fromEntries(CLI_IDS.map((cli) => [cli, true]))
  const cliSettings = vi.fn(async () => remote({ enabled }))
  const setCliEnabled = vi.fn(async (_session, cli: CliId, next: boolean) => {
    enabled = { ...enabled, [cli]: next }
    return remote({ enabled })
  })
  const api = {
    cliworker: { catalogForCli, accountStatus, configure, cliSettings, setCliEnabled, ...overrides },
  } as unknown as API
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
  return {
    r,
    text,
    button,
    click,
    open,
    submit,
    api,
    configure,
    accountStatus,
    catalogForCli,
    cliSettings,
    setCliEnabled,
  }
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
  expect(accountStatus.mock.calls.filter((call) => call[1] === 'antigravity')).toHaveLength(2)
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

it('persists each CLI switch without moving the current navigation row until reopening', async () => {
  const t = await setup()
  const navigation = () => t.r.root.findByProps({ 'aria-label': 'CLI 设置导航' }).findAllByType('button')
  expect(navigation().map((button) => button.props['aria-label'])).toEqual(
    CLI_IDS.map((id) => `${CLI_LABELS[id]} 设置`),
  )
  await t.click('启用 Antigravity')
  expect(t.setCliEnabled.mock.calls[0]!.slice(0, 3)).toEqual(['simulation-parent', 'antigravity', false])
  expect(t.button('启用 Antigravity').props['aria-checked']).toBe(false)
  expect(t.button('Antigravity 设置').props['data-enabled']).toBe(false)
  expect(t.button('默认模型').props.disabled).toBe(true)
  expect(t.button('保存默认值').props.disabled).toBe(true)
  expect(navigation()[0]!.props['aria-label']).toBe('Antigravity 设置')
  await t.click('Codex 设置')
  expect(t.button('启用 Codex').props['aria-checked']).toBe(true)
  await t.click('关闭设置')
  await t.open()
  expect(navigation().at(-1)!.props['aria-label']).toBe('Antigravity 设置')
  expect(t.button('启用 Antigravity').props['aria-checked']).toBe(false)
})
it('keeps the same account action and form controls while discovery is pending and after it completes', async () => {
  const pendingAccount = deferred(),
    pendingModels = deferred()
  const t = await setup({
    accountStatus: vi.fn((_parent, cli: CliId) =>
      cli === 'antigravity' ? pendingAccount.promise : Promise.resolve(status(cli)),
    ),
    catalogForCli: vi.fn(() => pendingModels.promise),
  })
  const actionButtons = () =>
    t.r.root.findByProps({ className: 'cwn-account-actions' }).findAllByType('button')
  expect(actionButtons()).toHaveLength(3)
  expect(actionButtons().every((button) => button.props.disabled)).toBe(true)
  expect(t.button('默认模型')).toBeDefined()
  expect(t.button('默认思考强度')).toBeDefined()
  const sectionsBefore = t.r.root.findAllByProps({ className: 'cwn-settings-section' }).length
  await act(async () => {
    pendingAccount.resolve(
      status('antigravity', { actions: [{ id: 'login', label: '登录 / 切换账号', description: '模拟' }] }),
    )
    pendingModels.resolve(catalog('antigravity'))
  })
  expect(actionButtons()).toHaveLength(3)
  expect(actionButtons()[0]!.props.disabled).toBe(false)
  expect(t.r.root.findAllByProps({ className: 'cwn-settings-section' })).toHaveLength(sectionsBefore)
  expect(t.button('默认模型').props.disabled).toBe(false)
})
it('does not query disabled CLIs and never allows stale account results to re-enable their controls', async () => {
  const pending = deferred()
  const t = await setup({
    accountStatus: vi.fn((_parent, cli: CliId) =>
      cli === 'antigravity' ? pending.promise : Promise.resolve(status(cli)),
    ),
  })
  await t.click('启用 Antigravity')
  await act(async () =>
    pending.resolve(
      status('antigravity', {
        summary: 'stale disabled account',
        actions: [{ id: 'login', label: '模拟登录', description: '模拟' }],
      }),
    ),
  )
  expect(t.text()).not.toContain('stale disabled account')
  expect(t.button('登录 / 切换账号').props.disabled).toBe(true)
  expect(terminal.started).not.toHaveBeenCalled()
  const modelsBeforeReopen = t.catalogForCli.mock.calls.length
  await t.click('关闭设置')
  await t.open()
  expect(t.catalogForCli.mock.calls.length).toBe(modelsBeforeReopen)
  expect(t.button('默认模型').props.disabled).toBe(true)
  await t.click('启用 Antigravity')
  expect(t.catalogForCli.mock.calls.length).toBe(modelsBeforeReopen + 1)
})
it('shows truthful connection dots and distinguishes CLI availability from verified authentication', async () => {
  const t = await setup({
    accountStatus: vi.fn(async (_parent, cli: CliId) =>
      status(cli, {
        state: cli === 'codex' ? 'authenticated' : cli === 'claude' ? 'unauthenticated' : 'unknown',
      }),
    ),
  })
  expect(t.button('Codex 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state']).toBe(
    'connected',
  )
  expect(t.button('Codex 设置').findByProps({ role: 'img' }).props['aria-label']).toContain('账号已登录')
  expect(
    t.button('Claude Code 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('failed')
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    '模型目录已连接；账号未验证',
  )
})
it('keeps a rejected enablement change scoped to its CLI and preserves the saved state', async () => {
  const write = deferred()
  const t = await setup({ setCliEnabled: vi.fn(() => write.promise) })
  await t.click('启用 Antigravity')
  await t.click('Codex 设置')
  expect(t.button('启用 Codex').props.disabled).toBe(true)
  await act(async () => write.reject(new Error('模拟：CLI 有活动任务')))
  expect(t.text()).not.toContain('模拟：CLI 有活动任务')
  expect(t.button('启用 Codex').props.disabled).toBe(false)
  await t.click('Antigravity 设置')
  expect(t.text()).toContain('模拟：CLI 有活动任务')
  expect(t.button('启用 Antigravity').props['aria-checked']).toBe(true)
})

it('does not start discovery before saved enablement loads and keeps navigation available', async () => {
  const preferences = deferred()
  const t = await setup({ cliSettings: vi.fn(() => preferences.promise) })
  expect(t.catalogForCli).not.toHaveBeenCalled()
  expect(t.accountStatus).not.toHaveBeenCalled()
  expect(t.button('启用 Antigravity').props.disabled).toBe(true)
  expect(t.button('默认模型')).toBeDefined()
  await t.click('Codex 设置')
  expect(t.button('启用 Codex').props.disabled).toBe(true)
  await act(async () =>
    preferences.resolve(
      remote({ enabled: Object.fromEntries(CLI_IDS.map((id) => [id, id !== 'antigravity'])) }),
    ),
  )
  expect(t.catalogForCli.mock.calls.map((call) => call[1])).toEqual(['codex'])
  expect(t.accountStatus.mock.calls.map((call) => call[1])).not.toContain('antigravity')
  expect(t.button('启用 Codex').props.disabled).toBe(false)
})
it('caches status across navigation and permits only one in-flight status probe per CLI', async () => {
  const t = await setup()
  await t.click('Codex 设置')
  await t.click('Antigravity 设置')
  expect(t.accountStatus.mock.calls.filter((call) => call[1] === 'antigravity')).toHaveLength(1)
  const pending = deferred()
  t.accountStatus.mockReturnValueOnce(pending.promise)
  await t.click('刷新状态')
  expect(t.button('刷新状态').props.disabled).toBe(true)
  // Directly invoke the disabled handler as a stress check on the parent guard.
  await t.click('刷新状态')
  expect(t.accountStatus.mock.calls.filter((call) => call[1] === 'antigravity')).toHaveLength(2)
  await act(async () => pending.resolve(status('antigravity')))
  expect(t.button('刷新状态').props.disabled).toBe(false)
})
it('stops loading indicators after an enablement query failure without dispatching CLI probes', async () => {
  const t = await setup({ cliSettings: vi.fn().mockRejectedValue(new Error('模拟：设置读取失败')) })
  expect(t.text()).toContain('模拟：设置读取失败')
  expect(t.text()).not.toContain('data-loading')
  expect(t.accountStatus).not.toHaveBeenCalled()
  expect(t.catalogForCli).not.toHaveBeenCalled()
  expect(t.button('启用 Antigravity').props.disabled).toBe(true)
  expect(t.button('关闭设置').props.disabled).not.toBe(true)
})

it('does not equate an installed CLI with a verified connection and only verifies Antigravity after reading its models', async () => {
  const models = deferred()
  const t = await setup({
    catalogForCli: vi.fn((_parent, cli: CliId) =>
      cli === 'antigravity' ? models.promise : Promise.resolve(catalog(cli)),
    ),
    accountStatus: vi.fn(async (_parent, cli: CliId) =>
      status(cli, { state: cli === 'kimi' ? 'configured' : 'unknown' }),
    ),
  })
  expect(
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('unknown')
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    'CLI 已安装，连接状态待验证',
  )
  expect(t.button('Codex 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state']).toBe(
    'unknown',
  )
  expect(t.button('Kimi 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state']).toBe(
    'unknown',
  )
  expect(t.button('Kimi 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    '已配置凭据，连接状态待验证',
  )
  await act(async () => models.resolve(catalog('antigravity')))
  expect(
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('connected')
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    '模型目录已连接；账号未验证',
  )
})

it('dismisses an open model menu when its CLI is disabled and does not reopen it on enable', async () => {
  const t = await setup()
  await t.click('默认模型')
  expect(t.button('默认模型').props['aria-expanded']).toBe(true)
  await t.click('启用 Antigravity')
  expect(t.button('默认模型').props['aria-expanded']).toBe(false)
  await t.click('启用 Antigravity')
  expect(t.button('默认模型').props.disabled).toBe(false)
  expect(t.button('默认模型').props['aria-expanded']).toBe(false)
})

it('updates Antigravity connection from successful live catalog to failed and back after an explicit retry', async () => {
  const catalogForCli = vi
    .fn()
    .mockResolvedValueOnce(catalog('antigravity'))
    .mockRejectedValueOnce(new Error('模拟目录连接失败'))
    .mockResolvedValueOnce(catalog('antigravity'))
  const t = await setup({ catalogForCli })
  const dot = () =>
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state']
  expect(dot()).toBe('connected')
  await t.click('刷新模型')
  expect(dot()).toBe('failed')
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    '模型目录读取失败，请刷新模型重试',
  )
  await t.click('刷新模型')
  expect(dot()).toBe('connected')
})
it('treats an empty catalog as failed while an unqueried CLI remains unknown and local catalogs do not verify credentials', async () => {
  const t = await setup({
    catalogForCli: vi.fn(async (_parent, cli: CliId) =>
      cli === 'antigravity' ? remote({ cli, models: [] }) : catalog(cli),
    ),
    accountStatus: vi.fn(async (_parent, cli: CliId) => status(cli, { state: 'configured' })),
  })
  const dot = (label: string) =>
    t.button(label).findByProps({ className: 'cwn-connection-dot' }).props['data-state']
  expect(dot('Antigravity 设置')).toBe('failed')
  expect(dot('Codex 设置')).toBe('unknown')
  await t.click('Codex 设置')
  expect(t.text()).toContain('codex-fixture')
  expect(dot('Codex 设置')).toBe('unknown')
})
it('never upgrades an explicit unauthenticated account to connected after a model catalog succeeds', async () => {
  const t = await setup({
    accountStatus: vi.fn(async (_parent, cli: CliId) =>
      status(cli, { state: 'unauthenticated', summary: '模拟：请先登录' }),
    ),
  })
  expect(
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('failed')
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe('模拟：请先登录')
})
