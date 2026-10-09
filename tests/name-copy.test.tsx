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
