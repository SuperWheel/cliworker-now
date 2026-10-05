import { createElement, forwardRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { Panel } from '../src/client/panel.tsx'
import type { API, Snapshot } from '../src/client/workers.ts'
import { CLI_IDS, type Worker, type HistoryPage } from '../src/shared/types.ts'

const clipboard = vi.hoisted(() => vi.fn().mockResolvedValue(true))
// Only the native control skins is replaced; actual Panel, hooks and stream consumer run.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  writeClipboard: clipboard,
  Tooltip: ({ children }: any) => children,
  StateDot: () => createElement('span', { 'data-loading': true }),
  Switch: ({ checked, onChange, label, disabled }: any) =>
    createElement('button', {
      role: 'switch',
      'aria-label': label,
      'aria-checked': checked,
      disabled,
      onClick: () => onChange(!checked),
    }),
  Modal: ({ open, title, children, onClose, closeLabel }: any) =>
    open
      ? createElement(
          'section',
          { role: 'dialog', 'aria-label': title },
          createElement('button', { 'aria-label': closeLabel, onClick: onClose }, closeLabel),
          children,
        )
      : null,
  useAnchoredPosition: () => null,
  useDismissOnOutsidePointer: () => {},
  IconCheckOutlineRegular: () => createElement('svg'),
  IconChevronRightOutlineRegular: () => createElement('svg'),
  IconDatabaseOutlineRegular: () => createElement('svg'),
  IconGaugeOutlineRegular: () => createElement('svg'),
  IconSettingsOutlineRegular: () => createElement('svg'),
  IconSendOutlineRegular: () => createElement('svg'),
  IconCopyOutlineRegular: () => createElement('svg'),
  IconChevronDownOutlineRegular: () => createElement('svg'),
  MarkdownText: ({ text }: any) => createElement('div', {}, text),
  MenuItemButton: ({ children, onSelect, disabled }: any) =>
    createElement('button', { onClick: onSelect, disabled }, children),
  Menu: ({ anchor, open, items = [], onSelect, children }: any) =>
    createElement(
      'div',
      {},
      anchor,
      open &&
        createElement(
          'div',
          {},
          items.map((item: any) =>
            createElement(
              'button',
              {
                key: item.id,
                'aria-label': item.id,
                disabled: item.disabled,
                onClick: () => onSelect(item.id),
              },
              item.text ?? item.label,
            ),
          ),
          children,
        ),
    ),
  Input: forwardRef(({ icon, className, ...props }: any, ref) =>
    createElement('span', { className }, icon, createElement('input', { ...props, ref })),
  ),
  Button: forwardRef(({ children, variant: _variant, size: _size, ...props }: any, ref) =>
    createElement('button', { type: 'button', ...props, ref }, children),
  ),
}))
const workers: Worker[] = ['a', 'b'].map((id) => ({
  id,
  parentSessionId: 'parent',
  project: '/fixture',
  title: `Worker ${id}`,
  preference: { model: 'fixture', effort: 'low' },
  mode: 'accept-edits',
  status: 'completed',
  createdAt: '',
  updatedAt: '',
  runId: `run-${id}`,
  conversationId: `cli-${id}`,
}))
class Stream {
  private queue: string[] = []
  private wake?: () => void
  private error?: Error
  private closed = false
  accept = vi.fn()
  push(snapshot: Snapshot) {
    this.queue.push(JSON.stringify(snapshot))
    this.wake?.()
  }
  fail() {
    this.error = new Error('fixture disconnected')
    this.wake?.()
  }
  async dispose() {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.error) throw this.error
      const text = this.queue.shift()
      if (text) yield { value: text, accept: this.accept }
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}
const mounted: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount()
  })
})
const deferred = () => {
  let resolve!: (value: any) => void, reject!: (reason: unknown) => void
  const promise = new Promise<any>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function setup(openFirst = true) {
  clipboard.mockReset().mockResolvedValue(true)
  const streams: Stream[] = []
  const history = vi.fn()
  const followup = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  const api = {
    $stream: () => {
      const s = new Stream()
      streams.push(s)
      return s
    },
    cliworker: {
      followup,
      history,
      cliSettings: vi.fn(async () => ({
        ok: true,
        value: JSON.stringify({ enabled: Object.fromEntries(CLI_IDS.map((id) => [id, true])) }),
      })),
      accountStatus: vi.fn(async (_parent, cli) => ({
        ok: true,
        value: JSON.stringify({
          cli,
          installed: true,
          state: 'unknown',
          summary: '模拟账号状态未知',
          actions: [],
        }),
      })),
    },
  } as unknown as API
  const feed = { scrollTop: 0, scrollHeight: 1400, clientHeight: 300 }
  let r!: ReactTestRenderer
  await act(async () => {
    r = create(<Panel api={api} sessionId="parent" />, {
      createNodeMock: (el) => (el.props.className === 'cwn-feed' ? feed : null),
    })
    mounted.push(r)
  })
  const snapshot = (id?: string, revision = 1, overrides: Partial<Worker> = {}): Snapshot => ({
    workers,
    selected: id ? { ...workers.find((w) => w.id === id)!, ...overrides } : undefined,
    revision,
    truncated: false,
    timeline: id
      ? [{ id: `message-${id}`, kind: 'assistant', text: `answer-${id}`, time: '2026-10-04T00:00:00Z' }]
      : [],
  })
  const push = async (id?: string, revision?: number, overrides?: Partial<Worker>) => {
    await act(async () => {
      streams.at(-1)!.push(snapshot(id, revision, overrides))
    })
  }
  await push()
  if (openFirst) {
    await act(async () => {
      r.root.findByProps({ 'data-worker-id': 'a' }).props.onClick()
    })
    await push('a')
  }
  const text = () => JSON.stringify(r.toJSON())
  const input = () => r.root.findByType('textarea')
  const edit = async (value: string) => {
    await act(async () => {
      input().props.onChange({ target: { value } })
    })
  }
  const click = async (label: string) => {
    await act(async () => {
      r.root
        .findAllByType('button')
        .find((b) => b.children.includes(label) || b.props['aria-label'] === label)!
        .props.onClick()
    })
  }
  const goBack = async () => {
    await click('返回子 Agent 列表')
    await push()
  }
  const select = async (id: string) => {
    if (r.root.findAllByProps({ 'aria-label': '返回子 Agent 列表' }).length) await goBack()
    await act(async () => {
      r.root.findByProps({ 'data-worker-id': id }).props.onClick()
    })
  }
  const submit = async () => {
    await act(async () => {
      r.root.findByProps({ className: 'cwn-compose' }).props.onSubmit({ preventDefault() {} })
    })
  }
  return {
    r,
    streams,
    api,
    followup,
    history,
    feed,
    push,
    snapshot,
    text,
    input,
    edit,
    click,
    select,
    submit,
    goBack,
  }
}
it('preserves each worker draft and hides old content while switching', async () => {
  const t = await setup()
  await t.edit('draft A')
  await t.select('b')
  expect(t.text()).not.toContain('answer-a')
  await t.push('b')
  expect(t.input().props.value).toBe('')
  await t.edit('draft B')
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('draft A')
  await t.select('b')
  await t.push('b')
  expect(t.input().props.value).toBe('draft B')
})
it('late submission success clears only its originating draft', async () => {
  const t = await setup(),
    done = deferred()
  t.followup.mockReturnValue(done.promise)
  await t.edit('submit A')
  await t.submit()
  await t.select('b')
  await t.push('b')
  await t.edit('keep B')
  await act(async () => {
    done.resolve({ ok: true, value: '{}' })
  })
  expect(t.input().props.value).toBe('keep B')
  expect(t.followup).toHaveBeenCalledWith('parent', 'a', 'submit A')
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('')
})
it('late errors belong to the original worker and preserve its draft', async () => {
  const t = await setup(),
    done = deferred()
  t.followup.mockReturnValue(done.promise)
  await t.edit('retry A')
  await t.submit()
  await t.select('b')
  await t.push('b')
  await act(async () => {
    done.reject(new Error('fixture submission failed'))
  })
  expect(t.text()).not.toContain('fixture submission failed')
  await t.select('a')
  await t.push('a')
  expect(t.text()).toContain('fixture submission failed')
  expect(t.input().props.value).toBe('retry A')
})
it('reconnect preserves received history and draft without dispatching or duplicating messages', async () => {
  const t = await setup()
  await t.edit('unsent')
  await act(async () => {
    t.streams.at(-1)!.fail()
  })
  expect(t.text()).toContain('answer-a')
  expect(t.input().props.disabled).toBe(true)
  await t.click('重新连接')
  expect(t.text()).toContain('answer-a')
  await t.push('a')
  expect(t.text().match(/answer-a/g)).toHaveLength(1)
  expect(t.input().props.value).toBe('unsent')
  expect(t.followup).not.toHaveBeenCalled()
})
it('keeps reading position during updates and offers jump to latest', async () => {
  const t = await setup()
  t.feed.scrollTop = 50
  await act(async () => {
    t.r.root.findByProps({ className: 'cwn-feed' }).props.onScroll()
  })
  t.feed.scrollHeight = 2000
  await t.push('a', 2)
  expect(t.feed.scrollTop).toBe(50)
  await t.click('↓ 回到最新消息')
  expect(t.feed.scrollTop).toBe(2000)
  expect(t.text()).not.toContain('↓ 回到最新消息')
})
it('explains missing CLI session and displays durable interrupted errors', async () => {
  const t = await setup()
  await t.push('a', 2, { status: 'interrupted', conversationId: undefined, error: '上次 Harness 运行中断' })
  expect(t.text()).toContain('无法续聊')
  expect(t.text()).toContain('上次 Harness 运行中断')
  expect(t.input().props.disabled).toBe(true)
})
it('changing parent session hides prior worker and ignores old stream updates', async () => {
  const t = await setup(),
    oldStream = t.streams.at(-1)!
  await act(async () => {
    t.r.update(<Panel api={t.api} sessionId="other-parent" />)
  })
  await act(async () => {
    oldStream.push({ workers, timeline: [], revision: 50, truncated: false })
  })
  expect(t.text()).not.toContain('Worker a')
  expect(t.text()).not.toContain('answer-a')
})

const oldPage = (workerId = 'a'): HistoryPage => ({
  workerId,
  items: [{ id: 'old-row', kind: 'assistant', text: 'historical answer', time: '2026-10-04T00:00:00Z' }],
  start: 0,
  end: 1,
  total: 2,
  hasOlder: false,
  hasNewer: true,
})
it('keeps historical content and reading position stable while live snapshots arrive', async () => {
  const t = await setup()
  await act(async () => {
    t.streams.at(-1)!.push({ ...t.snapshot('a'), truncated: true })
  })
  t.history.mockResolvedValue({ ok: true, value: JSON.stringify(oldPage()) })
  await t.click('查看更早记录')
  expect(t.history).toHaveBeenCalledWith('parent', 'a', 'message-a', 'before')
  expect(t.text()).toContain('historical answer')
  t.feed.scrollTop = 40
  await t.push('a', 10)
  expect(t.text()).not.toContain('answer-a')
  expect(t.feed.scrollTop).toBe(40)
  await t.click('返回实时')
  expect(t.text()).toContain('answer-a')
  expect(t.text()).not.toContain('historical answer')
  expect(t.followup).not.toHaveBeenCalled()
})
it('ignores a delayed history page after changing workers', async () => {
  const t = await setup(),
    result = deferred()
  await act(async () => {
    t.streams.at(-1)!.push({ ...t.snapshot('a'), truncated: true })
  })
  t.history.mockReturnValue(result.promise)
  await t.click('查看更早记录')
  await t.select('b')
  await t.push('b')
  await act(async () => {
    result.resolve({ ok: true, value: JSON.stringify(oldPage()) })
  })
  expect(t.text()).not.toContain('historical answer')
  expect(t.text()).toContain('answer-b')
})
it('preserves the overview filters and each draft across back navigation', async () => {
  const t = await setup()
  await t.edit('draft remains')
  await t.goBack()
  expect(t.r.root.findAllByType('textarea')).toHaveLength(0)
  await act(async () =>
    t.r.root.findByProps({ 'aria-label': '筛选子 Agent' }).props.onChange({ target: { value: 'worker A' } }),
  )
  const list = () => t.r.root.findAll((n) => n.type === 'button' && n.props['data-worker-id'])
  expect(list()).toHaveLength(1)
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('draft remains')
  expect(t.r.root.findAllByProps({ 'aria-label': '子 Agent' })).toHaveLength(0)
  await t.goBack()
  expect(t.r.root.findByProps({ 'aria-label': '筛选子 Agent' }).props.value).toBe('worker A')
  await t.click('进行中')
  expect(list()).toHaveLength(0)
  expect(t.text()).toContain('没有匹配的任务')
  await t.click('清除筛选')
  expect(list()).toHaveLength(2)
  await t.select('a')
  await t.push('a')
  expect(t.input().props.value).toBe('draft remains')
})
it('copies the exact current result and reports clipboard refusal honestly', async () => {
  const t = await setup()
  await t.push('a', 2, { lastResult: 'exact result\n' })
  await t.click('复制最新结果')
  expect(clipboard).toHaveBeenLastCalledWith('exact result\n')
  expect(t.text()).toContain('已复制')
  clipboard.mockResolvedValue(false)
  await t.click('复制回复')
  expect(clipboard).toHaveBeenLastCalledWith('answer-a')
  expect(t.text()).toContain('复制失败，请选择文本手动复制')
})

it('selects defaults per CLI and limits effort choices to the selected model', async () => {
  const f = await setup()
  const catalogForCli = vi.fn(async (_parent, cli) => ({
    ok: true,
    value: JSON.stringify({
      cli,
      models:
        cli === 'kimi'
          ? [{ id: 'kimi-model', efforts: ['default'] }]
          : [
              { id: 'model-a', efforts: ['low', 'high'] },
              { id: 'model-b', efforts: ['high'] },
            ],
    }),
  }))
  const configure = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(f.api.cliworker, { catalogForCli, configure })
  await f.click('默认设置')
  await f.click('Codex 设置')
  await f.click('默认模型')
  await f.click('model-b')
  expect(f.text()).toContain('high')
  await f.click('Kimi 设置')
  expect(f.text()).toContain('沿用 CLI 配置')
  expect(f.r.root.findAllByType('button').find((b) => b.children.includes('保存默认值'))?.props.type).toBe(
    'submit',
  )
  await act(async () =>
    f.r.root.findByProps({ className: 'cwn-settings-form' }).props.onSubmit({ preventDefault() {} }),
  )
  expect(JSON.parse(configure.mock.calls[0]![1])).toEqual({
    cli: 'kimi',
    model: 'kimi-model',
    effort: 'default',
  })
})
it('failed CLI discovery clears the previous catalog and prevents saving it to another CLI', async () => {
  const f = await setup()
  Object.assign(f.api.cliworker, {
    catalogForCli: vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: JSON.stringify({ cli: 'antigravity', models: [{ id: 'm', efforts: ['low'] }] }),
      })
      .mockRejectedValueOnce(new Error('CLI missing')),
  })
  await f.click('默认设置')
  await f.click('MiMo 设置')
  expect(f.text()).toContain('CLI missing')
  expect(
    f.r.root.findAllByType('button').find((b) => b.children.includes('保存默认值'))?.props.disabled,
  ).toBe(true)
  expect(
    f.r.root.findAllByType('button').find((b) => b.props['aria-label'] === '默认模型')?.props.disabled,
  ).toBe(true)
})

it('uses the selected CLI name in assistant messages and shows the reported model alias target', async () => {
  const f = await setup()
  await f.push('a', 2, {
    preference: { cli: 'claude', model: 'sonnet', effort: 'low' },
    observedModel: 'glm-example',
  })
  expect(
    f.r.root.findByProps({ className: 'cwn-message-label' }).findByProps({ className: 'cwn-sr-only' })
      .children[0],
  ).toBe('Claude Code')
  expect(f.text()).toContain('glm-example')
})

it('starts on grouped overview without auto-opening a worker and keeps collapsed groups', async () => {
  const t = await setup(false)
  const mixed = [
    ...workers,
    {
      ...workers[0]!,
      id: 'c',
      title: 'Codex task',
      preference: { cli: 'codex' as const, model: 'gpt-example', effort: 'high' as const },
      status: 'running' as const,
    },
  ]
  await act(async () =>
    t.streams.at(-1)!.push({ workers: mixed, timeline: [], revision: 2, truncated: false }),
  )
  const groups = () => t.r.root.findAllByProps({ className: 'cwn-cli-group' })
  expect(groups()).toHaveLength(2)
  expect(groups()[0]!.findAllByProps({ className: 'cwn-worker' })).toHaveLength(2)
  expect(groups()[1]!.findAllByProps({ className: 'cwn-worker' })).toHaveLength(1)
  expect(t.r.root.findAllByType('textarea')).toHaveLength(0)
  const line = groups()[1]!.findByProps({ className: 'cwn-worker-line' })
  expect(line.children[0].props.className).toBe('cwn-worker-title')
  expect(line.children[1].props.className).toContain('cwn-worker-status')
  await act(async () => groups()[1]!.findByProps({ className: 'cwn-cli-heading' }).props.onClick())
  expect(groups()[1]!.findAllByProps({ className: 'cwn-worker' })).toHaveLength(0)
  await t.select('a')
  await t.push('a')
  await t.goBack()
  await act(async () =>
    t.streams.at(-1)!.push({ workers: mixed, timeline: [], revision: 3, truncated: false }),
  )
  expect(groups()[1]!.findByProps({ className: 'cwn-cli-heading' }).props['aria-expanded']).toBe(false)
})
it('keeps metadata out of child header and stops through the integrated composer without sending text', async () => {
  const t = await setup()
  const stop = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(t.api.cliworker, { stop })
  await t.push('a', 2, { status: 'running' })
  const header = t.r.root.findByProps({ className: 'cwn-head' })
  expect(header.findAllByProps({ title: '派遣时选择的模型' })).toHaveLength(0)
  expect(header.findAllByProps({ className: 'cwn-back' })).not.toHaveLength(0)
  expect(t.text()).toContain('fixture')
  expect(t.input().props.disabled).toBe(true)
  await t.click('停止')
  expect(stop).toHaveBeenCalledWith('parent', 'a')
  expect(t.followup).not.toHaveBeenCalled()
})

it('model menu updates an idle worker without dispatching or changing project defaults', async () => {
  const t = await setup()
  const configureWorker = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  const configure = vi.fn()
  Object.assign(t.api.cliworker, {
    catalogForCli: vi.fn().mockResolvedValue({
      ok: true,
      value: JSON.stringify({ models: [{ id: 'next-model', efforts: ['low'] }] }),
    }),
    configureWorker,
    configure,
  })
  await t.click('模型与强度')
  await t.click('model')
  await act(async () => {
    t.r.root
      .findAllByType('button')
      .find((b) => b.findAll((n) => n.type === 'span' && n.children.includes('next-model')).length > 0)!
      .props.onClick()
  })
  expect(configureWorker).toHaveBeenCalledWith(
    'parent',
    'a',
    JSON.stringify({ cli: 'antigravity', model: 'next-model', effort: 'low' }),
  )
  expect(configure).not.toHaveBeenCalled()
  expect(t.followup).not.toHaveBeenCalled()
})
it('model catalog failure is recoverable and never appears as a raw transport option', async () => {
  const t = await setup()
  Object.assign(t.api.cliworker, {
    catalogForCli: vi.fn().mockRejectedValue(new Error('transport failure: HTTP 404')),
  })
  await t.click('模型与强度')
  expect(t.text()).toContain('插件服务尚未更新')
  expect(t.text()).not.toContain('HTTP 404')
  expect(t.text()).not.toContain('transport failure')
})

it('closing settings during slow CLI discovery leaves conversation and stop controls available', async () => {
  const t = await setup(),
    models = deferred()
  const stop = vi.fn().mockResolvedValue({ ok: true, value: '{}' })
  Object.assign(t.api.cliworker, { catalogForCli: vi.fn().mockReturnValue(models.promise), stop })
  await t.click('默认设置')
  expect(t.text()).toContain('正在读取 Antigravity 模型')
  await t.click('关闭设置')
  expect(t.input().props.disabled).toBe(false)
  await t.edit('可以继续输入')
  await t.push('a', 2, { status: 'running' })
  await t.click('停止')
  expect(stop).toHaveBeenCalledWith('parent', 'a')
  await act(async () =>
    models.resolve({
      ok: true,
      value: JSON.stringify({ cli: 'antigravity', models: [{ id: 'late model', efforts: ['low'] }] }),
    }),
  )
  expect(t.text()).not.toContain('late model')
})
