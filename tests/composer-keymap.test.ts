import { describe, expect, it, vi } from 'vitest'
import { createComposerKeymap, type ComposerKeyEvent } from '../src/client/composer-keymap.ts'

function key(overrides: Partial<ComposerKeyEvent> = {}) {
  return {
    key: 'Enter',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    getModifierState: vi.fn(() => false),
    preventDefault: vi.fn(),
    ...overrides,
  } satisfies ComposerKeyEvent
}

function fixture() {
  let time = 100
  const canSubmit = vi.fn(() => true)
  const submit = vi.fn()
  const handlers = createComposerKeymap(canSubmit, submit, () => time)
  return { handlers, canSubmit, submit, advance: (ms: number) => (time += ms) }
}

describe('Worker composer native keyboard gestures', () => {
  it.each([
    ['Enter', {}],
    ['Ctrl+Enter', { ctrlKey: true }],
    ['Cmd+Enter', { metaKey: true }],
  ])('%s submits through the supplied form action once without a line break', (_name, modifiers) => {
    const { handlers, canSubmit, submit } = fixture()
    const event = key(modifiers)
    handlers.onKeyDown(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(canSubmit).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('leaves Shift+Enter to the textarea for a line break', () => {
    const { handlers, canSubmit, submit } = fixture()
    const event = key({ shiftKey: true })
    handlers.onKeyDown(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(canSubmit).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it.each([
    ['Alt+Enter', { altKey: true }],
    ['AltGraph+Enter', { getModifierState: vi.fn((name) => name === 'AltGraph') }],
    ['Ctrl+Cmd+Enter', { ctrlKey: true, metaKey: true }],
    ['Shift+Ctrl+Enter', { shiftKey: true, ctrlKey: true }],
    ['Shift+Cmd+Enter', { shiftKey: true, metaKey: true }],
    ['Alt+Ctrl+Enter', { altKey: true, ctrlKey: true }],
    ['Alt+Cmd+Enter', { altKey: true, metaKey: true }],
  ])('%s keeps the native unsupported-chord behavior without submitting', (_name, modifiers) => {
    const { handlers, canSubmit, submit } = fixture()
    const event = key(modifiers)
    handlers.onKeyDown(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(canSubmit).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it.each(['a', 'Escape', 'ArrowDown', ' ', 'Tab'])('does not take ownership of %j', (name) => {
    const { handlers, canSubmit, submit } = fixture()
    const event = key({ key: name })
    handlers.onKeyDown(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(canSubmit).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('consumes repeated Enter without creating duplicate submissions', () => {
    const { handlers, canSubmit, submit } = fixture()
    const first = key()
    const repeated = key({ repeat: true })
    handlers.onKeyDown(first)
    handlers.onKeyDown(repeated)
    handlers.onKeyDown(repeated)
    expect(submit).toHaveBeenCalledOnce()
    expect(canSubmit).toHaveBeenCalledOnce()
    expect(repeated.preventDefault).toHaveBeenCalledTimes(2)
  })

  it('checks current availability for each accepted gesture and prevents unavailable Enter line breaks', () => {
    const { handlers, canSubmit, submit } = fixture()
    canSubmit.mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(false)
    const blocked = key()
    const allowed = key({ ctrlKey: true })
    const laterBlocked = key({ metaKey: true })
    handlers.onKeyDown(blocked)
    handlers.onKeyDown(allowed)
    handlers.onKeyDown(laterBlocked)
    expect(blocked.preventDefault).toHaveBeenCalledOnce()
    expect(allowed.preventDefault).toHaveBeenCalledOnce()
    expect(laterBlocked.preventDefault).toHaveBeenCalledOnce()
    expect(canSubmit).toHaveBeenCalledTimes(3)
    expect(submit).toHaveBeenCalledOnce()
  })
})

describe('Worker composer native composition protection', () => {
  it.each([
    ['isComposing', { isComposing: true, keyCode: 13 }],
    ['legacy keyCode 229', { isComposing: false, keyCode: 229 }],
  ])('preserves an IME confirmation signalled by %s', (_name, nativeEvent) => {
    const { handlers, canSubmit, submit } = fixture()
    const event = key({ nativeEvent })
    handlers.onKeyDown(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(canSubmit).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('protects composition even when an engine omits the keyboard flag', () => {
    const { handlers, canSubmit, submit, advance } = fixture()
    handlers.onCompositionStart()
    advance(1000)
    const event = key({ metaKey: true })
    handlers.onKeyDown(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(canSubmit).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('protects the Safari closing-key window and accepts a new Enter exactly at 10ms', () => {
    const { handlers, canSubmit, submit, advance } = fixture()
    handlers.onCompositionStart()
    handlers.onCompositionEnd()
    const closing = key()
    handlers.onKeyDown(closing)
    advance(9)
    const withinWindow = key()
    handlers.onKeyDown(withinWindow)
    expect(closing.preventDefault).not.toHaveBeenCalled()
    expect(withinWindow.preventDefault).not.toHaveBeenCalled()
    expect(canSubmit).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    advance(1)
    const next = key()
    handlers.onKeyDown(next)
    expect(next.preventDefault).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('a fresh composition renews the confirmation window', () => {
    const { handlers, submit, advance } = fixture()
    handlers.onCompositionStart()
    handlers.onCompositionEnd()
    advance(10)
    handlers.onCompositionStart()
    const during = key()
    handlers.onKeyDown(during)
    handlers.onCompositionEnd()
    advance(9)
    const closing = key()
    handlers.onKeyDown(closing)
    expect(submit).not.toHaveBeenCalled()
    advance(1)
    handlers.onKeyDown(key())
    expect(submit).toHaveBeenCalledOnce()
  })

  it.each(['active', 'closing'] as const)(
    'reset removes the %s composition state after changing Worker',
    (state) => {
      const { handlers, submit } = fixture()
      handlers.onCompositionStart()
      if (state === 'closing') handlers.onCompositionEnd()
      handlers.reset()
      const nextWorker = key()
      handlers.onKeyDown(nextWorker)
      expect(nextWorker.preventDefault).toHaveBeenCalledOnce()
      expect(submit).toHaveBeenCalledOnce()
    },
  )

  it('a new Worker keymap does not inherit the previous Worker composition state', () => {
    const previous = fixture()
    previous.handlers.onCompositionStart()
    const current = fixture()
    current.handlers.onKeyDown(key())
    expect(previous.submit).not.toHaveBeenCalled()
    expect(current.submit).toHaveBeenCalledOnce()
  })
})
