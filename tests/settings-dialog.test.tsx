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
  IconLinkOutlineRegular: () => createElement('svg'),
  IconRefreshOutlineRegular: () => createElement('svg'),
  IconUserOutlineRegular: () => createElement('svg'),
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
  Input: forwardRef(({ icon, ...props }: any, ref) =>
    createElement('span', {}, icon, createElement('input', { ...props, ref })),
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
const accountActions: AccountStatus['actions'] = [
  { id: 'login', label: '登录 / 切换账号', description: '模拟登录能力说明' },
  { id: 'logout', label: '退出登录', description: '模拟退出能力说明' },
  { id: 'manage', label: '账号终端', description: '模拟管理能力说明' },
]
async function setup(overrides: Record<string, any> = {}, openNativeSettings?: () => void) {
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
      openNativeSettings={openNativeSettings}
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
  expect(visibleText(accountSummary(t.r))).not.toContain('stale-account')
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
        actions: [{ id: 'manage', label: '账号终端', description: '由模拟 Host 提供' }],
      }),
    ),
  })
  expect(visibleText(accountSummary(t.r))).toContain('模拟状态无法确认')
  expect(t.text()).not.toContain('未登录')
  expect(t.button('登录')).toBeUndefined()
  expect(terminal.started).not.toHaveBeenCalled()
  await t.click('账号终端')
  expect(terminal.started).toHaveBeenCalledExactlyOnceWith('antigravity', 'manage')
  const dialog = t.r.root.findByProps({ role: 'dialog', 'aria-label': 'Antigravity · 账号终端' })
  expect(dialog.findByProps({ 'data-terminal': 'antigravity' })).toBeDefined()
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
    status(cli, { actions: [{ id: 'login', label: '登录 / 切换账号', description: '模拟' }] }),
  )
  const t = await setup({ accountStatus })
  await t.click('登录 / 切换账号')
  await t.click('完成模拟账号操作')
  expect(accountStatus.mock.calls.filter((call) => call[1] === 'antigravity')).toHaveLength(2)
  expect(t.catalogForCli).toHaveBeenCalledTimes(2)
  await t.click('关闭设置')
  expect(terminal.stopped).toHaveBeenCalledExactlyOnceWith('antigravity', 'login')
})

it('replaces a pending account check after an account action finishes and rechecks on outer dismissal', async () => {
  const stale = deferred()
  const accountStatus = accountFixture({
    state: 'authenticated',
    verification: 'cli',
    actions: accountActions,
  })
  const t = await setup({ accountStatus })
  await t.click('登录 / 切换账号')
  accountStatus.mockReturnValueOnce(stale.promise)
  await t.click('刷新状态')
  const pendingSignal = accountStatus.mock.calls.at(-1)![2]
  await t.click('完成模拟账号操作')
  expect(pendingSignal.aborted).toBe(true)
  expect(accountStatus.mock.calls.filter((call) => call[1] === 'antigravity')).toHaveLength(3)
  await act(async () =>
    stale.resolve(status('antigravity', { state: 'unauthenticated', summary: 'stale-before-login' })),
  )
  expect(t.text()).not.toContain('stale-before-login')
  const modelsBeforeClose = t.catalogForCli.mock.calls.length
  await t.click('关闭账号操作')
  expect(accountStatus.mock.calls.filter((call) => call[1] === 'antigravity')).toHaveLength(4)
  expect(t.catalogForCli.mock.calls.length).toBe(modelsBeforeClose + 1)
  expect(t.configure).not.toHaveBeenCalled()
})

it('opens an account action in its own dialog only after a click and dismisses it without closing settings', async () => {
  const t = await setup({ accountStatus: accountFixture({ actions: accountActions }) })
  expect(t.r.root.findAllByProps({ role: 'dialog' })).toHaveLength(1)
  expect(terminal.started).not.toHaveBeenCalled()
  await t.click('刷新状态')
  await t.click('刷新模型')
  expect(terminal.started).not.toHaveBeenCalled()

  await t.click('登录 / 切换账号')
  expect(terminal.started).toHaveBeenCalledExactlyOnceWith('antigravity', 'login')
  expect(t.r.root.findAllByProps({ role: 'dialog' })).toHaveLength(2)
  const dialog = t.r.root.findByProps({ role: 'dialog', 'aria-label': 'Antigravity · 登录 / 切换账号' })
  expect(dialog.findByProps({ 'data-terminal': 'antigravity' })).toBeDefined()
  expect(t.button('登录 / 切换账号').props.disabled).toBe(true)
  expect(t.button('账号终端').props.disabled).toBe(true)

  await t.click('关闭账号操作')
  expect(terminal.stopped).toHaveBeenCalledExactlyOnceWith('antigravity', 'login')
  expect(t.r.root.findAllByProps({ role: 'dialog' })).toHaveLength(1)
  expect(t.r.root.findByProps({ role: 'dialog', 'aria-label': 'CLI Worker 设置' })).toBeDefined()
  expect(t.button('登录 / 切换账号').props.disabled).toBe(false)
  expect(terminal.started).toHaveBeenCalledTimes(1)
})

it.each(['关闭账号操作', 'Codex 设置'])(
  'cleans up the account action via %s even when its completion status refresh fails',
  async (dismiss) => {
    const accountStatus = accountFixture({ actions: accountActions })
    const t = await setup({ accountStatus })
    await t.click('登录 / 切换账号')
    accountStatus.mockImplementation(async (_parent, cli: CliId) => {
      if (cli === 'antigravity') throw new Error('模拟：操作后状态查询失败')
      return status(cli)
    })
    await t.click('完成模拟账号操作')
    expect(visibleText(accountSummary(t.r))).toContain('模拟：操作后状态查询失败')
    expect(
      t.r.root.findByProps({ role: 'dialog', 'aria-label': 'Antigravity · 登录 / 切换账号' }),
    ).toBeDefined()
    expect(t.button('关闭账号操作').props.disabled).not.toBe(true)
    await t.click(dismiss)
    expect(terminal.stopped).toHaveBeenCalledExactlyOnceWith('antigravity', 'login')
    expect(t.r.root.findAllByProps({ role: 'dialog' })).toHaveLength(1)
    expect(t.r.root.findAllByProps({ 'data-terminal': 'antigravity' })).toHaveLength(0)
    await t.click('Antigravity 设置')
    expect(terminal.started).toHaveBeenCalledTimes(1)
    expect(t.button('登录 / 切换账号').props.disabled).toBe(true)
  },
)

it.each<AccountStatus['state']>(['unknown', 'configured', 'unconfigured', 'unauthenticated', 'unavailable'])(
  'does not offer logout for %s status even if the CLI declares that capability',
  async (state) => {
    const t = await setup({ accountStatus: accountFixture({ state, actions: accountActions }) })
    expect(t.button('退出登录')).toBeUndefined()
    expect(terminal.started).not.toHaveBeenCalled()
  },
)

it('offers logout alongside an authenticated account and dispatches only logout after an explicit click', async () => {
  const t = await setup({
    accountStatus: accountFixture({
      state: 'authenticated',
      authMethod: 'oauth',
      verification: 'cli',
      accountLabel: 'fixture@example.invalid',
      actions: accountActions,
    }),
  })
  expect(
    accountSummary(t.r)
      .findAllByType('button')
      .some((button) => button.props['aria-label'] === '退出登录'),
  ).toBe(true)
  expect(t.button('退出登录').props.disabled).toBe(false)
  expect(terminal.started).not.toHaveBeenCalled()
  await t.click('刷新状态')
  await t.click('Codex 设置')
  expect(t.button('退出登录')).toBeUndefined()
  await t.click('Antigravity 设置')
  expect(terminal.started).not.toHaveBeenCalled()
  await t.click('退出登录')
  expect(terminal.started).toHaveBeenCalledExactlyOnceWith('antigravity', 'logout')
  expect(t.r.root.findByProps({ role: 'dialog', 'aria-label': 'Antigravity · 退出登录' })).toBeDefined()
  await t.click('关闭账号操作')
  expect(terminal.stopped).toHaveBeenCalledExactlyOnceWith('antigravity', 'logout')
  expect(terminal.started).toHaveBeenCalledTimes(1)
})

it('displays only the native model name while saving the exact provider/model identifier', async () => {
  const id = 'account:bigmodel-individual-coding-plan/GLM-5.3'
  const label = 'GLM-5.3（BigModel · 模拟）'
  const t = await setup({
    catalogForCli: vi.fn(async (_parent, cli: CliId) =>
      cli === 'zcode' ? remote({ cli, models: [{ id, label, efforts: ['default'] }] }) : catalog(cli),
    ),
  })
  await t.click('ZCode 设置')
  expect(visibleText(t.button('默认模型'))).toContain('GLM-5.3')
  expect(visibleText(t.button('默认模型'))).not.toContain('BigModel')
  expect(visibleText(t.button('默认模型'))).not.toMatch(/[()（）]/u)
  await t.submit()
  expect(JSON.parse(t.configure.mock.calls[0]![1])).toEqual({ cli: 'zcode', model: id, effort: 'default' })
})

it('deduplicates route names and puts proven free models first without combining route capabilities', async () => {
  const models = [
    { id: 'paid/GLM-5.3', label: 'GLM-5.3（paid source）', cost: 'paid', efforts: ['high'] },
    { id: 'paid/GLM-5.3-Flash', label: 'GLM-5.3-Flash（paid source）', cost: 'paid', efforts: ['medium'] },
    { id: 'free/glm-5.3', label: 'GLM-5.3 (free source)', cost: 'free', efforts: ['default'] },
  ]
  const t = await setup({
    catalogForCli: vi.fn(async (_parent, cli: CliId) =>
      cli === 'zcode' ? remote({ cli, models }) : catalog(cli),
    ),
  })
  await t.click('ZCode 设置')
  expect(visibleText(t.button('默认模型')).trim()).toBe('GLM-5.3')
  expect(visibleText(t.button('默认思考强度'))).toContain('沿用 CLI 配置')
  expect(t.configure).not.toHaveBeenCalled()
  await t.click('默认模型')
  const menu = t.r.root.findByProps({ role: 'menu' })
  expect(menu.findAllByType('button').map((button) => visibleText(button))).toEqual([
    'GLM-5.3',
    'GLM-5.3-Flash',
  ])
  expect(visibleText(menu)).not.toMatch(/source|[()（）]/u)
  await t.click('GLM-5.3-Flash')
  expect(visibleText(t.button('默认思考强度')).trim()).toBe('medium')
  await t.submit()
  expect(JSON.parse(t.configure.mock.calls[0]![1])).toEqual({
    cli: 'zcode',
    model: 'paid/GLM-5.3-Flash',
    effort: 'medium',
  })
})

it('retains the exact valid saved paid route when a free duplicate is available', async () => {
  const models = [
    { id: 'free/chat', label: 'Chat（free source）', cost: 'free', efforts: ['default'] },
    { id: 'paid/chat', label: 'Chat（paid source）', cost: 'paid', efforts: ['high'] },
  ]
  const t = await setup({
    catalogForCli: vi.fn(async (_parent, cli: CliId) =>
      cli === 'pi'
        ? remote({ cli, models, preference: { cli, model: 'paid/chat', effort: 'high' } })
        : catalog(cli),
    ),
  })
  await t.click('Pi 设置')
  expect(visibleText(t.button('默认模型')).trim()).toBe('Chat')
  expect(visibleText(t.button('默认思考强度')).trim()).toBe('high')
  expect(t.configure).not.toHaveBeenCalled()
  await t.click('默认模型')
  expect(t.r.root.findByProps({ role: 'menu' }).findAllByType('button')).toHaveLength(1)
  await t.click('Chat')
  await t.submit()
  expect(JSON.parse(t.configure.mock.calls[0]![1])).toEqual({ cli: 'pi', model: 'paid/chat', effort: 'high' })
})

it('asks to reselect an unavailable saved route instead of silently switching to a duplicate', async () => {
  const t = await setup({
    catalogForCli: vi.fn(async (_parent, cli: CliId) =>
      cli === 'omp'
        ? remote({
            cli,
            models: [{ id: 'free/chat', label: 'Chat（free source）', cost: 'free', efforts: ['default'] }],
            preference: { cli, model: 'removed/chat', effort: 'high' },
          })
        : catalog(cli),
    ),
  })
  await t.click('OMP 设置')
  expect(visibleText(t.button('默认模型')).trim()).toBe('选择模型')
  expect(t.text()).toContain('原默认模型已不可用，请重新选择模型')
  expect(t.button('保存默认值').props.disabled).toBe(true)
  await t.submit()
  expect(t.configure).not.toHaveBeenCalled()
  await t.click('默认模型')
  await t.click('Chat')
  await t.submit()
  expect(JSON.parse(t.configure.mock.calls[0]![1])).toEqual({
    cli: 'omp',
    model: 'free/chat',
    effort: 'default',
  })
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
  const navigation = () =>
    t.r.root
      .findByProps({ 'aria-label': 'CLI 设置导航' })
      .findAllByType('button')
      .filter((button) => button.props.className === 'cwn-settings-cli-item')
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
it('opens the role library separately from CLI settings and returns to the same CLI', async () => {
  const rolePresets = vi.fn(async () =>
    remote([{ id: 'logic', name: '逻辑审稿人', summary: '模拟因果审查', prompt: '模拟角色' }]),
  )
  const t = await setup({ rolePresets })
  await t.click('Codex 设置')
  await t.click('智能体设置')
  expect(rolePresets).toHaveBeenCalledOnce()
  expect(t.text()).toContain('模拟因果审查')
  expect(t.button('Codex 设置').props['aria-pressed']).toBe(false)
  expect(t.r.root.findAllByProps({ 'aria-label': 'Codex 配置' })).toHaveLength(0)
  await t.click('Codex 设置')
  expect(t.button('Codex 设置').props['aria-pressed']).toBe(true)
  expect(t.r.root.findAllByProps({ 'aria-label': 'Codex 配置' })).toHaveLength(1)
})
it('collapses CLI navigation without changing the selected page or restarting its account flow', async () => {
  const t = await setup({
    accountStatus: vi.fn(async (_parent, cli: CliId) => status(cli, { actions: accountActions })),
  })
  await t.click('Codex 设置')
  await t.click('登录 / 切换账号')
  const callsBefore = t.catalogForCli.mock.calls.length
  const groupId = t.button('CLI 连接').props['aria-controls']
  const group = () => t.r.root.findByProps({ id: groupId })
  expect(t.button('CLI 连接').props['aria-expanded']).toBe(true)
  expect(t.button('Codex 设置').props.tabIndex).toBeUndefined()

  await t.click('CLI 连接')
  expect(t.button('CLI 连接').props['aria-expanded']).toBe(false)
  expect(group().props['aria-hidden']).toBe(true)
  expect(group().props.inert).toBe('')
  expect(
    group()
      .findAllByType('button')
      .every((button) => button.props.tabIndex === -1),
  ).toBe(true)
  expect(t.button('Codex 设置').props['aria-pressed']).toBe(true)
  expect(t.r.root.findAllByProps({ 'aria-label': 'Codex 配置' })).toHaveLength(1)
  expect(terminal.stopped).not.toHaveBeenCalled()

  await t.click('CLI 连接')
  expect(t.button('CLI 连接').props['aria-expanded']).toBe(true)
  expect(group().props['aria-hidden']).toBe(false)
  expect(group().props.inert).toBeUndefined()
  expect(t.button('Codex 设置').props.tabIndex).toBeUndefined()
  expect(t.catalogForCli).toHaveBeenCalledTimes(callsBefore)
  expect(terminal.started).toHaveBeenCalledExactlyOnceWith('codex', 'login')
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
  expect(actionButtons().map((button) => button.props['aria-label'])).toEqual(['登录 / 切换账号', '账号终端'])
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
  expect(actionButtons().map((button) => button.props['aria-label'])).toEqual(['登录 / 切换账号', '账号终端'])
  expect(t.button('登录 / 切换账号').props.disabled).toBe(false)
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
        actions: [{ id: 'login', label: '登录 / 切换账号', description: '模拟' }],
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
        verification: 'cli',
      }),
    ),
  })
  expect(t.button('Codex 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state']).toBe(
    'connected',
  )
  expect(t.button('Codex 设置').findByProps({ role: 'img' }).props['aria-label']).toBe('已登录')
  expect(
    t.button('Claude Code 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('failed')
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    'antigravity 模拟状态待确认',
  )
})
it.each(['zcode', 'grok', 'omp', 'pi', 'hermes', 'opencode'] as const)(
  'keeps %s configured credentials neutral before and after its model directory loads',
  async (cli) => {
    const models = deferred()
    const t = await setup({
      accountStatus: vi.fn(async (_parent, id: CliId) =>
        status(id, {
          state: 'configured',
          verification: 'local',
          authMethod: 'oauth',
          accountLabel: 'fixture@example.invalid',
        }),
      ),
      catalogForCli: vi.fn((_parent, id: CliId) =>
        id === cli ? models.promise : Promise.resolve(catalog(id)),
      ),
    })
    const nav = `${CLI_LABELS[cli]} 设置`
    expect(t.button(nav).findByProps({ className: 'cwn-connection-dot' }).props['data-state']).toBe(
      'unverified',
    )
    await t.click(nav)
    expect(t.button(nav).findAllByProps({ 'data-loading': true })).toHaveLength(0)
    expect(t.button('保存默认值').props.disabled).toBe(true)
    await act(async () => models.resolve(catalog(cli)))
    expect(t.button(nav).findByProps({ className: 'cwn-connection-dot' }).props['data-state']).toBe(
      'unverified',
    )
    expect(visibleText(accountSummary(t.r))).toContain('已配置')
    expect(visibleText(accountSummary(t.r))).not.toContain('已登录')
    expect(terminal.started).not.toHaveBeenCalled()
    expect(t.configure).not.toHaveBeenCalled()
  },
)

it.each(['antigravity', 'mimo'] as const)(
  'keeps %s logged in while invalidating model choices during a catalog refresh and failure',
  async (cli) => {
    const read = deferred()
    const t = await setup({
      accountStatus: vi.fn(async (_parent, id: CliId) =>
        status(id, { state: 'authenticated', verification: 'cli' }),
      ),
    })
    await t.click(`${CLI_LABELS[cli]} 设置`)
    expect(t.button('保存默认值').props.disabled).toBe(false)
    t.catalogForCli.mockReturnValueOnce(read.promise)
    await t.click('刷新模型')
    expect(t.button(`${CLI_LABELS[cli]} 设置`).findAllByProps({ 'data-loading': true })).toHaveLength(0)
    expect(visibleText(accountSummary(t.r))).toContain('已登录')
    expect(visibleText(t.button('默认模型'))).toContain('选择模型')
    expect(t.button('默认模型').props.disabled).toBe(true)
    expect(t.button('保存默认值').props.disabled).toBe(true)
    await t.submit()
    await act(async () => read.reject(new Error('模拟：当前账号无可用模型')))
    expect(
      t.button(`${CLI_LABELS[cli]} 设置`).findByProps({ className: 'cwn-connection-dot' }).props[
        'data-state'
      ],
    ).toBe('connected')
    expect(visibleText(accountSummary(t.r))).toContain('已登录')
    expect(t.text()).not.toContain(`${cli}-fixture`)
    expect(t.button('保存默认值').props.disabled).toBe(true)
    expect(t.text()).toContain('模拟：当前账号无可用模型')
    expect(t.configure).not.toHaveBeenCalled()
  },
)

it('waits for a refreshed account before reading its new model scope and ignores the superseded catalog', async () => {
  const oldModels = deferred(),
    freshModels = deferred(),
    account = deferred()
  const catalogForCli = vi
    .fn()
    .mockResolvedValueOnce(catalog('antigravity', 'original-model'))
    .mockReturnValueOnce(oldModels.promise)
    .mockReturnValueOnce(freshModels.promise)
  const accountStatus = accountFixture({ state: 'authenticated', verification: 'cli' })
  const t = await setup({ catalogForCli, accountStatus })
  await t.click('刷新模型')
  accountStatus.mockReturnValueOnce(account.promise)
  await t.click('刷新状态')
  expect(catalogForCli).toHaveBeenCalledTimes(2)
  expect(catalogForCli.mock.calls[1]![2].aborted).toBe(true)
  expect(t.button('保存默认值').props.disabled).toBe(true)
  expect(visibleText(accountSummary(t.r))).toContain('已登录')
  expect(
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('connected')
  await act(async () => oldModels.resolve(catalog('antigravity', 'stale-account-model')))
  expect(t.text()).not.toContain('stale-account-model')
  await act(async () =>
    account.resolve(status('antigravity', { state: 'configured', verification: 'local' })),
  )
  expect(catalogForCli).toHaveBeenCalledTimes(3)
  expect(t.button('保存默认值').props.disabled).toBe(true)
  expect(visibleText(accountSummary(t.r))).toContain('已配置')
  expect(
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('unverified')
  await act(async () => freshModels.resolve(catalog('antigravity', 'new-account-model')))
  expect(t.text()).toContain('new-account-model')
  expect(t.text()).not.toContain('original-model')
  expect(t.configure).not.toHaveBeenCalled()
})

it('rejects cross-CLI account and model responses without exposing their identities or choices', async () => {
  const t = await setup({
    accountStatus: vi.fn(async () =>
      status('pi', { state: 'authenticated', verification: 'cli', accountLabel: 'wrong-account' }),
    ),
    catalogForCli: vi.fn(async () => catalog('pi', 'wrong-cli-model')),
  })
  expect(t.text()).toContain('收到不匹配的 CLI 账号状态')
  expect(t.text()).toContain('收到不匹配的 CLI 模型目录')
  expect(t.text()).not.toContain('wrong-account')
  expect(t.text()).not.toContain('wrong-cli-model')
  expect(t.button('保存默认值').props.disabled).toBe(true)
  expect(terminal.started).not.toHaveBeenCalled()
})

it('shows an empty catalog reason and releases its pending navigation indicator when switching away', async () => {
  const read = deferred()
  const t = await setup({
    catalogForCli: vi.fn((_parent, cli: CliId) =>
      cli === 'antigravity'
        ? read.promise
        : Promise.resolve(
            remote({
              cli,
              models: [],
              notice: '模拟：当前账号范围未知，请完成原生登录后刷新',
            }),
          ),
    ),
  })
  await t.click('Codex 设置')
  expect(t.button('Antigravity 设置').findAllByProps({ 'data-loading': true })).toHaveLength(0)
  expect(t.text()).toContain('模拟：当前账号范围未知，请完成原生登录后刷新')
  expect(t.button('保存默认值').props.disabled).toBe(true)
  await act(async () => read.resolve(catalog('antigravity', 'late-model')))
  expect(t.text()).not.toContain('late-model')
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

it('keeps unknown accounts grey even after reading models and shows configured credentials with their evidence scope', async () => {
  const models = deferred()
  const t = await setup({
    catalogForCli: vi.fn((_parent, cli: CliId) =>
      cli === 'antigravity' ? models.promise : Promise.resolve(catalog(cli)),
    ),
    accountStatus: vi.fn(async (_parent, cli: CliId) =>
      status(cli, { state: cli === 'kimi' ? 'configured' : 'unknown' }),
    ),
  })
  expect(t.button('Antigravity 设置').findAllByProps({ 'data-loading': true })).toHaveLength(0)
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    'antigravity 模拟状态待确认',
  )
  expect(t.button('Codex 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state']).toBe(
    'unknown',
  )
  expect(t.button('Kimi 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state']).toBe(
    'unverified',
  )
  expect(t.button('Kimi 设置').findByProps({ role: 'img' }).props['aria-label']).toBe('已配置')
  await act(async () => models.resolve(catalog('antigravity')))
  expect(
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('unknown')
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    'antigravity 模拟状态待确认',
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

it('keeps an unknown Antigravity account grey across catalog failure and retry', async () => {
  const catalogForCli = vi
    .fn()
    .mockResolvedValueOnce(catalog('antigravity'))
    .mockRejectedValueOnce(new Error('模拟目录连接失败'))
    .mockResolvedValueOnce(catalog('antigravity'))
  const t = await setup({ catalogForCli })
  const dot = () =>
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state']
  expect(dot()).toBe('unknown')
  await t.click('刷新模型')
  expect(dot()).toBe('unknown')
  expect(t.text()).toContain('模拟目录连接失败')
  expect(t.button('Antigravity 设置').findByProps({ role: 'img' }).props['aria-label']).toBe(
    'antigravity 模拟状态待确认',
  )
  await t.click('刷新模型')
  expect(dot()).toBe('unknown')
})
it.each(['rejected', 'empty'] as const)(
  'keeps the authenticated account summary short and shows the useful model error from a %s catalog',
  async (failure) => {
    const reason = '模拟：无法确认当前自身账号，请登录后刷新'
    const t = await setup({
      accountStatus: accountFixture({
        state: 'authenticated',
        authMethod: 'oauth',
        accountLabel: 'fixture@example.invalid',
        actions: accountActions,
      }),
      catalogForCli: vi.fn(async (_parent, cli: CliId) => {
        if (failure === 'rejected') throw new Error(`CliAccountBindingError: ${reason}`)
        return remote({ cli, models: [], notice: `Error: CliAccountBindingError: ${reason}` })
      }),
    })
    const summary = accountSummary(t.r)
    expect(visibleText(summary.findByProps({ className: 'cwn-account-login' })).trim()).toBe('已登录')
    expect(summary.props['data-account-state']).toBe('authenticated')
    expect(visibleText(summary)).toContain('fixture@example.invalid')
    expect(summary.findByProps({ className: 'cwn-account-status-dot' }).props['data-state']).toBe('connected')
    expect(t.text()).toContain(reason)
    expect(t.text()).not.toContain('Error:')
    if (failure === 'rejected') expect(t.button('默认模型').props.disabled).toBe(true)
    expect(t.button('保存默认值').props.disabled).toBe(true)
    expect(t.configure).not.toHaveBeenCalled()
  },
)
it('keeps configured credentials neutral when the model catalog is empty', async () => {
  const t = await setup({
    catalogForCli: vi.fn(async (_parent, cli: CliId) =>
      cli === 'antigravity' ? remote({ cli, models: [] }) : catalog(cli),
    ),
    accountStatus: vi.fn(async (_parent, cli: CliId) => status(cli, { state: 'configured' })),
  })
  const dot = (label: string) =>
    t.button(label).findByProps({ className: 'cwn-connection-dot' }).props['data-state']
  expect(dot('Antigravity 设置')).toBe('unverified')
  expect(dot('Codex 设置')).toBe('unverified')
  await t.click('Codex 设置')
  expect(t.text()).toContain('codex-fixture')
  expect(dot('Codex 设置')).toBe('unverified')
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

function accountSummary(renderer: ReactTestRenderer) {
  return renderer.root.find(
    (node) =>
      typeof node.props.className === 'string' &&
      node.props.className.split(/\s+/).includes('cwn-account-summary'),
  )
}
function visibleText(node: ReturnType<typeof accountSummary>): string {
  return node.children.map((child) => (typeof child === 'string' ? child : visibleText(child))).join(' ')
}
function accountFixture(changes: Partial<AccountStatus>) {
  return vi.fn(async (_parent, cli: CliId) => status(cli, cli === 'antigravity' ? changes : {}))
}

it.each(['unconfigured', 'unauthenticated', 'unavailable', 'unknown', 'configured'] as const)(
  'keeps both health indicators consistent for %s while preserving model error evidence',
  async (state) => {
    const t = await setup({
      accountStatus: accountFixture({ state, summary: `模拟：${state}` }),
      catalogForCli: vi.fn(async (_parent, cli: CliId) =>
        cli === 'antigravity' ? remote({ cli, models: [] }) : catalog(cli),
      ),
    })
    const nav = t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props[
      'data-state'
    ]
    const summary = accountSummary(t.r).findByProps({ className: 'cwn-account-status-dot' }).props[
      'data-state'
    ]
    expect(nav).toBe(
      state === 'unconfigured'
        ? 'unconfigured'
        : state === 'configured'
          ? 'unverified'
          : state === 'unknown'
            ? 'unknown'
            : 'failed',
    )
    expect(summary).toBe(nav)
    expect(t.text()).toContain('此 CLI 未返回可用模型')
    if (state === 'unconfigured') expect(visibleText(accountSummary(t.r))).toContain('未登录')
    if (state === 'unauthenticated')
      expect(visibleText(accountSummary(t.r))).toContain('模拟：unauthenticated')
  },
)

it('keeps account indicators unchanged after retrying a failed catalog without restarting account actions or altering preferences', async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error('模拟：目录损坏'))
    .mockResolvedValue(catalog('antigravity'))
  const t = await setup({
    catalogForCli: read,
    accountStatus: accountFixture({ state: 'configured', verification: 'local' }),
  })
  const dots = () => [
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
    accountSummary(t.r).findByProps({ className: 'cwn-account-status-dot' }).props['data-state'],
  ]
  expect(dots()).toEqual(['unverified', 'unverified'])
  await t.click('刷新模型')
  expect(dots()).toEqual(['unverified', 'unverified'])
  expect(visibleText(accountSummary(t.r))).toContain('已配置')
  expect(terminal.started).not.toHaveBeenCalled()
})

it('keeps an absent default installation grey in both indicators despite model lookup failure', async () => {
  const t = await setup({
    accountStatus: accountFixture({ state: 'unconfigured', installed: false, summary: '模拟：尚未安装 CLI' }),
    catalogForCli: vi.fn().mockRejectedValue(new Error('模拟：CLI 不存在')),
  })
  expect(
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
  ).toBe('unconfigured')
  expect(accountSummary(t.r).findByProps({ className: 'cwn-account-status-dot' }).props['data-state']).toBe(
    'unconfigured',
  )
  expect(visibleText(accountSummary(t.r))).toContain('未安装')
})

it('refreshes an invalid login to a readable configuration without writing preferences or starting a terminal', async () => {
  const accountStatus = accountFixture({ state: 'unauthenticated', summary: '模拟：登录已过期' })
  const t = await setup({
    accountStatus,
    catalogForCli: vi.fn(async (_parent, cli: CliId) =>
      remote({
        cli,
        models: [
          { id: 'simulation-first', efforts: ['low'] },
          { id: 'simulation-saved', efforts: ['high'] },
        ],
        preference: { cli, model: 'simulation-saved', effort: 'high' },
      }),
    ),
  })
  const dots = () => [
    t.button('Antigravity 设置').findByProps({ className: 'cwn-connection-dot' }).props['data-state'],
    accountSummary(t.r).findByProps({ className: 'cwn-account-status-dot' }).props['data-state'],
  ]
  expect(dots()).toEqual(['failed', 'failed'])
  expect(t.button('默认模型').findAllByType('span')[0].children).toContain('simulation-saved')
  accountStatus.mockImplementation((_parent, cli: CliId) =>
    Promise.resolve(status(cli, { state: 'configured', verification: 'local' })),
  )
  await t.click('刷新状态')
  expect(dots()).toEqual(['unverified', 'unverified'])
  expect(visibleText(accountSummary(t.r))).toContain('已配置')
  expect(t.button('默认模型').findAllByType('span')[0].children).toContain('simulation-saved')
  expect(t.configure).not.toHaveBeenCalled()
  expect(terminal.started).not.toHaveBeenCalled()
})

it('shows the authenticated OAuth account with its login indicator in the persistent account summary', async () => {
  const t = await setup({
    accountStatus: accountFixture({
      state: 'authenticated',
      authMethod: 'oauth',
      verification: 'cli',
      accountLabel: 'Fixture Person · fixture@example.invalid',
      summary: '模拟：原生 CLI 报告已登录',
    }),
  })
  const summary = accountSummary(t.r)
  expect(visibleText(summary)).toContain('已登录')
  expect(visibleText(summary)).toContain('Fixture Person · fixture@example.invalid')
  expect(summary.findByProps({ className: 'cwn-account-status-dot' }).props['data-state']).toBe('connected')
})
it('labels API authentication distinctly and never renders an API account label supplied by the host', async () => {
  const t = await setup({
    accountStatus: accountFixture({
      state: 'authenticated',
      authMethod: 'api',
      verification: 'cli',
      accountLabel: 'SIMULATED_SECRET_MUST_NOT_RENDER',
      summary: '模拟：API 凭据已配置',
    }),
  })
  expect(visibleText(accountSummary(t.r))).toContain('API 登录')
  expect(t.text()).not.toContain('SIMULATED_SECRET_MUST_NOT_RENDER')
  expect(accountSummary(t.r).findByProps({ className: 'cwn-account-status-dot' }).props['data-state']).toBe(
    'connected',
  )
})
it('shows only the login state when the authenticated CLI has no account identity', async () => {
  const t = await setup({
    accountStatus: accountFixture({
      state: 'authenticated',
      authMethod: 'oauth',
      verification: 'cli',
      summary: '模拟：已登录',
    }),
  })
  expect(visibleText(accountSummary(t.r))).toContain('已登录')
  expect(visibleText(accountSummary(t.r))).not.toContain('CLI 未提供账号信息')
})
it.each(CLI_IDS)(
  'shows %s native authenticated sessions in one line regardless of local evidence source',
  async (cli) => {
    const t = await setup({
      accountStatus: vi.fn(async (_parent, id: CliId) =>
        status(id, {
          state: 'authenticated',
          authMethod: 'oauth',
          verification: 'local',
          accountLabel: 'fixture-local@example.invalid',
          summary: '模拟：本地登录信息；未进行远程验证；本地凭据不代表登录有效',
          actions: accountActions,
        }),
      ),
    })
    if (cli !== 'antigravity') await t.click(`${CLI_LABELS[cli]} 设置`)
    const summary = accountSummary(t.r)
    expect(visibleText(summary)).toContain('fixture-local@example.invalid')
    expect(visibleText(summary)).toContain('已登录')
    expect(summary.findByProps({ className: 'cwn-account-status-dot' }).props['data-state']).toBe('connected')
    expect(
      t.button(`${CLI_LABELS[cli]} 设置`).findByProps({ className: 'cwn-connection-dot' }).props[
        'data-state'
      ],
    ).toBe('connected')
    expect(summary.findAllByProps({ className: 'cwn-account-detail' })).toHaveLength(0)
    expect(t.text()).not.toMatch(
      /未进行远程验证|本地凭据不代表|模拟登录能力说明|模拟退出能力说明|模拟管理能力说明/,
    )
    expect(t.button('登录 / 切换账号').children).toContain('切换账号')
    expect(terminal.started).not.toHaveBeenCalled()
    expect(t.configure).not.toHaveBeenCalled()
  },
)
it('opens the native Kimi account manager with its explicit action label without logging out', async () => {
  const accountStatus = vi.fn(async (_parent, cli: CliId) => status(cli, {
    state: 'authenticated',
    authMethod: 'oauth',
    verification: 'local',
    actions: [
      { id: 'login', label: '管理登录', description: '模拟：由用户在原生终端管理登录' },
      { id: 'logout', label: '退出登录', description: '模拟退出' },
      { id: 'manage', label: '账号终端', description: '模拟账号终端' },
    ],
  }))
  const t = await setup({ accountStatus })
  await t.click('Kimi 设置')
  expect(t.button('管理登录').children).toContain('管理登录')
  expect(visibleText(accountSummary(t.r))).toContain('已登录')
  await t.click('管理登录')
  expect(terminal.started).toHaveBeenCalledWith('kimi', 'login')
  expect(terminal.started).not.toHaveBeenCalledWith('kimi', 'logout')
  expect(t.r.root.findByProps({ role: 'dialog', 'aria-label': 'Kimi · 管理登录' })).toBeTruthy()
  expect(t.configure).not.toHaveBeenCalled()
})
it.each([
  { state: 'authenticated', authMethod: 'api', verification: 'local', label: 'API 登录' },
  { state: 'configured', authMethod: 'api', verification: 'cli', label: '已配置' },
  { state: 'unconfigured', authMethod: undefined, verification: 'local', label: '未登录' },
] as const)(
  'shows only the short $label state without repeating Host summary or static protocol notes',
  async ({ state, authMethod, verification, label }) => {
    const t = await setup({
      accountStatus: accountFixture({
        state,
        authMethod,
        verification,
        summary: '模拟：Host 账号说明；未进行远程验证；本地凭据不代表登录有效',
      }),
      catalogForCli: vi.fn(async (_parent, cli: CliId) =>
        remote({
          cli,
          models: [{ id: `${cli}-fixture`, efforts: ['default'] }],
          notice: '模拟：CLI 协议适配静态备注',
        }),
      ),
    })
    expect(visibleText(accountSummary(t.r))).toContain(label)
    expect(accountSummary(t.r).findAllByProps({ className: 'cwn-account-detail' })).toHaveLength(0)
    expect(t.text()).not.toMatch(
      /模拟：Host 账号说明|未进行远程验证|本地凭据不代表|模拟：CLI 协议适配静态备注/,
    )
    expect(t.button('默认模型')).toBeDefined()
    expect(t.button('默认思考强度')).toBeDefined()
  },
)
it.each([
  { state: 'unauthenticated', summary: '登录已过期，请重新登录' },
  { state: 'unavailable', summary: 'CLI 路径无效，请重新安装' },
] as const)('preserves the actionable $state reason in the account row', async ({ state, summary }) => {
  const t = await setup({ accountStatus: accountFixture({ state, summary }) })
  expect(visibleText(accountSummary(t.r))).toContain(summary)
  expect(accountSummary(t.r).findAllByProps({ className: 'cwn-account-detail' })).toHaveLength(0)
  expect(accountSummary(t.r).findByProps({ className: 'cwn-account-status-dot' }).props['data-state']).toBe(
    'failed',
  )
})
it('preserves the last confirmed account while refreshing and replaces it after an account failure', async () => {
  const accountStatus = accountFixture({
    state: 'authenticated',
    authMethod: 'oauth',
    verification: 'cli',
    accountLabel: 'stale-fixture@example.invalid',
    summary: '模拟：已登录',
  })
  const t = await setup({ accountStatus })
  const before = accountSummary(t.r)
  expect(visibleText(before)).toContain('stale-fixture@example.invalid')
  const refresh = deferred()
  accountStatus.mockImplementation((_parent, cli: CliId) =>
    cli === 'antigravity' ? refresh.promise : Promise.resolve(status(cli)),
  )
  await t.click('刷新状态')
  expect(accountSummary(t.r)).toBe(before)
  expect(visibleText(accountSummary(t.r))).toContain('stale-fixture@example.invalid')
  expect(visibleText(accountSummary(t.r))).toContain('已登录')
  expect(accountSummary(t.r).findByProps({ className: 'cwn-account-status-dot' }).props['data-state']).toBe(
    'connected',
  )
  expect(t.button('Antigravity 设置').findAllByProps({ 'data-loading': true })).toHaveLength(0)
  expect(t.button('刷新状态').props.disabled).toBe(true)
  expect(t.button('保存默认值').props.disabled).toBe(true)
  await act(async () => refresh.reject(new Error('模拟：账号状态刷新失败')))
  expect(accountSummary(t.r)).toBe(before)
  expect(visibleText(accountSummary(t.r))).toContain('模拟：账号状态刷新失败')
  expect(visibleText(accountSummary(t.r))).not.toContain('stale-fixture@example.invalid')
  expect(visibleText(accountSummary(t.r))).not.toContain('已登录')
  expect(accountSummary(t.r).findAllByProps({ 'data-state': 'connected' })).toHaveLength(0)
})
it('keeps the same summary region after disabling a CLI while removing the previous authenticated identity', async () => {
  const t = await setup({
    accountStatus: accountFixture({
      state: 'authenticated',
      authMethod: 'oauth',
      verification: 'cli',
      accountLabel: 'disabled-fixture@example.invalid',
      summary: '模拟：已登录',
    }),
  })
  const before = accountSummary(t.r)
  await t.click('启用 Antigravity')
  expect(accountSummary(t.r)).toBe(before)
  expect(visibleText(accountSummary(t.r))).not.toContain('disabled-fixture@example.invalid')
  expect(visibleText(accountSummary(t.r))).not.toContain('已登录')
  expect(accountSummary(t.r).findAllByProps({ 'data-state': 'connected' })).toHaveLength(0)
  expect(t.button('登录 / 切换账号').props.disabled).toBe(true)
})

it.each(['pi', 'omp', 'opencode', 'hermes'] as const)(
  '%s opens a terminal login without native settings or redundant notes',
  async (cli) => {
    const actions: AccountStatus['actions'] = [
      { id: 'login', label: '登录设置', description: '模拟：原生登录' },
      { id: 'manage', label: '账号终端', description: '模拟：原生终端' },
    ]
    const openNativeSettings = vi.fn()
    const t = await setup(
      { accountStatus: vi.fn(async (_parent, current: CliId) => status(current, { actions })) },
      openNativeSettings,
    )
    await t.click(`${CLI_LABELS[cli]} 设置`)
    expect(t.button('登录设置').props.disabled).toBe(false)
    expect(t.text()).not.toContain('在原生设置中选择')
    await t.click('登录设置')
    expect(terminal.started).toHaveBeenCalledExactlyOnceWith(cli, 'login')
    expect(openNativeSettings).not.toHaveBeenCalled()
  },
)
it('offers Hermes instead of the removed Harness account settings', async () => {
  const t = await setup()
  expect(t.button('Hermes Agent 设置')).toBeDefined()
  expect(t.button('Harness 设置')).toBeUndefined()
  expect(t.button('Harness（已移除） 设置')).toBeUndefined()
  expect(t.accountStatus.mock.calls.some((call) => call[1] === 'harness')).toBe(false)
  await t.click('Hermes Agent 设置')
  expect(t.catalogForCli).toHaveBeenCalledWith('simulation-parent', 'hermes', expect.any(AbortSignal))
})
