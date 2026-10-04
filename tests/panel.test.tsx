import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { Panel } from '../src/client/panel.tsx'
import type { API, Snapshot } from '../src/client/workers.ts'
import type { Worker, HistoryPage } from '../src/shared/types.ts'

const clipboard = vi.hoisted(() => vi.fn().mockResolvedValue(true))
// Only the native button skin is replaced; actual Panel, hooks and stream consumer run.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  writeClipboard: clipboard,
  Button: ({ children, variant: _variant, size: _size, ...props }: any) =>
    createElement('button', props, children),
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
async function setup() {
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
    cliworker: { followup, history },
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
  await push('a')
  const text = () => JSON.stringify(r.toJSON())
  const input = () => r.root.findByProps({ 'aria-label': '继续对话' })
  const edit = async (value: string) => {
    await act(async () => {
      input().props.onChange({ target: { value } })
    })
  }
  const click = async (label: string) => {
    await act(async () => {
      r.root
        .findAllByType('button')
        .find((b) => b.children.includes(label))!
        .props.onClick()
    })
  }
  const select = async (id: string) => {
    await act(async () => {
      r.root
        .findAllByType('button')
        .find(
          (b) =>
            b.props.className?.includes('cwn-worker') &&
            JSON.stringify(b.findAllByType('span').map((s) => s.children)).includes(`Worker ${id}`),
        )!
        .props.onClick()
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
it('filters task list without changing selection or drafts', async () => {
  const t = await setup()
  await t.edit('draft remains')
  await act(async () => {
    t.r.root.findByProps({ 'aria-label': '筛选子 Agent' }).props.onChange({ target: { value: 'worker B' } })
  })
  const list = () => t.r.root.findByProps({ 'aria-label': '子 Agent' }).findAllByType('button')
  expect(list()).toHaveLength(1)
  expect(t.text()).toContain('当前查看的任务不在筛选结果中')
  expect(t.input().props.value).toBe('draft remains')
  await act(async () => {
    t.r.root.findByProps({ 'aria-label': '任务状态筛选' }).props.onChange({ target: { value: 'active' } })
  })
  expect(list()).toHaveLength(0)
  expect(t.text()).toContain('没有匹配的任务')
  await t.click('清除筛选')
  expect(list()).toHaveLength(2)
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
