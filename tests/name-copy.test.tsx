import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { NameCopy } from '../src/client/name-copy.tsx'

const clipboard = vi.hoisted(() => vi.fn())
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  writeClipboard: clipboard,
  Tooltip: ({ children }: any) => children,
  IconCheckOutlineRegular: () => createElement('svg'),
  IconCopyOutlineRegular: () => createElement('svg'),
}))
const mounted: ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  vi.useRealTimers()
  clipboard.mockReset()
})

it('does not apply an earlier clipboard result to a renamed worker', async () => {
  let resolve!: (copied: boolean) => void
  clipboard.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done
    }),
  )
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<NameCopy name="hermes-1" />)
    mounted.push(renderer)
  })
  const event = { stopPropagation: vi.fn() }
  await act(async () => renderer.root.findByType('button').props.onClick(event))
  expect(event.stopPropagation).toHaveBeenCalledOnce()
  expect(clipboard).toHaveBeenCalledWith('hermes-1')
  await act(async () => renderer.update(<NameCopy name="hermes-2" />))
  await act(async () => {
    resolve(true)
  })
  expect(renderer.root.findByType('button').props['aria-label']).toBe('复制名称 hermes-2')
  expect(renderer.root.findAllByProps({ role: 'status' })).toHaveLength(0)
})

it('cleans up copy feedback timing when the card unmounts', async () => {
  vi.useFakeTimers()
  clipboard.mockResolvedValue(true)
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<NameCopy name="pi-1" />)
    mounted.push(renderer)
  })
  await act(async () => renderer.root.findByType('button').props.onClick({ stopPropagation() {} }))
  expect(renderer.root.findByProps({ role: 'status' }).children).toEqual(['已复制'])
  expect(vi.getTimerCount()).toBe(1)
  await act(async () => renderer.unmount())
  expect(vi.getTimerCount()).toBe(0)
})

async function mount(name = 'agy-1', disabled = false) {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(<NameCopy name={name} disabled={disabled} />)
    mounted.push(renderer)
  })
  const button = () => renderer.root.findByType('button')
  const text = () => button().findByType('span').children.join('')
  const click = async (detail = 1) => {
    const event = { detail, stopPropagation: vi.fn() }
    await act(async () => button().props.onClick(event))
    return event
  }
  const advance = async (ms: number) => act(async () => vi.advanceTimersByTime(ms))
  return { renderer, button, text, click, advance }
}

it('shows text only and retains copied feedback throughout hover, then restores one second after leaving despite pointer focus', async () => {
  vi.useFakeTimers()
  clipboard.mockResolvedValue(true)
  const f = await mount()
  await act(async () => {
    f.button().props.onMouseEnter()
    f.button().props.onPointerDown()
    f.button().props.onFocus()
  })
  const event = await f.click()
  expect(event.stopPropagation).toHaveBeenCalledOnce()
  expect(f.text()).toBe('已复制')
  expect(f.button().findAllByType('svg')).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
  await f.advance(5000)
  expect(f.text()).toBe('已复制')
  await act(async () => f.button().props.onMouseLeave())
  expect(vi.getTimerCount()).toBe(1)
  await f.advance(999)
  expect(f.text()).toBe('已复制')
  await f.advance(1)
  expect(f.text()).toBe('agy-1')
})

it('cancels restoration on re-entry and starts a fresh delay on the next leave', async () => {
  vi.useFakeTimers()
  clipboard.mockResolvedValue(true)
  const f = await mount('codex-1')
  await act(async () => f.button().props.onMouseEnter())
  await f.click()
  await act(async () => f.button().props.onMouseLeave())
  await f.advance(800)
  await act(async () => f.button().props.onMouseEnter())
  expect(vi.getTimerCount()).toBe(0)
  await f.advance(5000)
  expect(f.text()).toBe('已复制')
  await act(async () => f.button().props.onMouseLeave())
  await f.advance(1000)
  expect(f.text()).toBe('codex-1')
})

it('holds keyboard feedback until blur without disabling the focused button during a copy', async () => {
  vi.useFakeTimers()
  let resolve!: (result: boolean) => void
  clipboard.mockReturnValue(new Promise<boolean>((done) => (resolve = done)))
  const f = await mount('hermes-1')
  await act(async () => {
    f.button().props.onFocus()
    f.button().props.onKeyDown({ key: 'Enter' })
  })
  await f.click(0)
  expect(f.button().props.disabled).toBe(false)
  expect(f.button().props['aria-busy']).toBe(true)
  await act(async () => resolve(true))
  expect(f.button().props['aria-busy']).toBe(false)
  await f.advance(5000)
  expect(f.text()).toBe('已复制')
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => f.button().props.onBlur())
  await f.advance(999)
  expect(f.text()).toBe('已复制')
  await f.advance(1)
  expect(f.text()).toBe('hermes-1')
})

it('pointer blur does not extend the delay already started by mouse leave', async () => {
  vi.useFakeTimers()
  clipboard.mockResolvedValue(true)
  const f = await mount()
  await act(async () => {
    f.button().props.onMouseEnter()
    f.button().props.onPointerDown()
    f.button().props.onFocus()
  })
  await f.click()
  await act(async () => f.button().props.onMouseLeave())
  await f.advance(500)
  await act(async () => f.button().props.onBlur())
  await f.advance(500)
  expect(f.text()).toBe('agy-1')
})

it('starts the delay after a slow copy completes when the pointer already left', async () => {
  vi.useFakeTimers()
  let resolve!: (result: boolean) => void
  clipboard.mockReturnValue(new Promise<boolean>((done) => (resolve = done)))
  const f = await mount()
  await act(async () => f.button().props.onMouseEnter())
  await f.click()
  await act(async () => f.button().props.onMouseLeave())
  expect(vi.getTimerCount()).toBe(0)
  await f.advance(5000)
  await act(async () => resolve(true))
  expect(f.text()).toBe('已复制')
  expect(vi.getTimerCount()).toBe(1)
  await f.advance(1000)
  expect(f.text()).toBe('agy-1')
})

it('re-entering before a slow copy settles retains its eventual feedback', async () => {
  vi.useFakeTimers()
  let resolve!: (result: boolean) => void
  clipboard.mockReturnValue(new Promise<boolean>((done) => (resolve = done)))
  const f = await mount()
  await act(async () => f.button().props.onMouseEnter())
  await f.click()
  await act(async () => {
    f.button().props.onMouseLeave()
    f.button().props.onMouseEnter()
  })
  await act(async () => resolve(true))
  await f.advance(5000)
  expect(f.text()).toBe('已复制')
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['false', 'throw'] as const)(
  'retains the selectable name and honest failure feedback for %s clipboard results',
  async (failure) => {
    vi.useFakeTimers()
    if (failure === 'throw') clipboard.mockRejectedValue(new Error('Synthetic clipboard failure'))
    else clipboard.mockResolvedValue(false)
    const f = await mount()
    await f.click()
    expect(f.text()).toBe('agy-1')
    expect(f.renderer.root.findByProps({ role: 'status' }).children).toEqual(['复制失败，请选择文本手动复制'])
    await act(async () => f.button().props.onMouseLeave())
    await f.advance(5000)
    expect(f.text()).toBe('agy-1')
    expect(vi.getTimerCount()).toBe(0)
  },
)

it('name changes supersede a pending copy, allowing the new name to copy without stale result or busy state', async () => {
  let first!: (result: boolean) => void, second!: (result: boolean) => void
  clipboard
    .mockReturnValueOnce(new Promise<boolean>((done) => (first = done)))
    .mockReturnValueOnce(new Promise<boolean>((done) => (second = done)))
  const f = await mount('pi-1')
  await f.click()
  await act(async () => f.renderer.update(<NameCopy name="pi-2" />))
  await f.click()
  await act(async () => first(true))
  expect(f.text()).toBe('pi-2')
  expect(f.button().props['aria-busy']).toBe(true)
  await act(async () => second(true))
  expect(f.text()).toBe('已复制')
  expect(clipboard.mock.calls).toEqual([['pi-1'], ['pi-2']])
})

it('disabling cancels pending feedback and prevents copying until enabled again', async () => {
  vi.useFakeTimers()
  let resolve!: (result: boolean) => void
  clipboard.mockReturnValue(new Promise<boolean>((done) => (resolve = done)))
  const f = await mount()
  await f.click()
  await act(async () => f.renderer.update(<NameCopy name="agy-1" disabled />))
  await act(async () => resolve(true))
  expect(f.text()).toBe('agy-1')
  expect(f.button().props.disabled).toBe(true)
  await f.click()
  expect(clipboard).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not publish feedback or a timer after an unmounted pending copy resolves', async () => {
  vi.useFakeTimers()
  let resolve!: (result: boolean) => void
  clipboard.mockReturnValue(new Promise<boolean>((done) => (resolve = done)))
  const f = await mount()
  await f.click()
  await act(async () => f.renderer.unmount())
  await act(async () => resolve(true))
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['name', 'disabled'] as const)(
  '%s changes clear an already scheduled restoration and copied feedback',
  async (change) => {
    vi.useFakeTimers()
    clipboard.mockResolvedValue(true)
    const f = await mount()
    await f.click()
    expect(vi.getTimerCount()).toBe(1)
    await f.advance(500)
    await act(async () =>
      f.renderer.update(
        <NameCopy name={change === 'name' ? 'agy-2' : 'agy-1'} disabled={change === 'disabled'} />,
      ),
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(f.text()).toBe(change === 'name' ? 'agy-2' : 'agy-1')
    await f.advance(5000)
    expect(f.renderer.root.findAllByProps({ role: 'status' })).toHaveLength(0)
  },
)

it('does not dispatch duplicate clipboard writes while pending, and allows a later retry', async () => {
  let resolve!: (copied: boolean) => void
  clipboard.mockReturnValueOnce(new Promise<boolean>((done) => (resolve = done)))
  const f = await mount()
  await f.click()
  await f.click()
  expect(clipboard).toHaveBeenCalledOnce()
  await act(async () => resolve(false))
  clipboard.mockResolvedValueOnce(true)
  await f.click()
  expect(clipboard).toHaveBeenCalledTimes(2)
  expect(f.text()).toBe('已复制')
})
