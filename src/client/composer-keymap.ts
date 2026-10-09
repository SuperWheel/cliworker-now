import type { KeyboardEvent } from 'react'

/** The event fields read by the native composer, narrowed for textarea and behavior tests. */
export type ComposerKeyEvent = Pick<
  KeyboardEvent<HTMLTextAreaElement>,
  'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'getModifierState' | 'preventDefault'
> & {
  nativeEvent: Pick<globalThis.KeyboardEvent, 'isComposing' | 'keyCode'>
}

/**
 * Adapt Harness 0.2.0-rc.2's private ui-conversation input/editor/keymap to a
 * Worker textarea. The native InputBar's Lexical editor and submit transport
 * belong to the Harness session; this adapter forwards accepted gestures to
 * the caller's existing form submission instead.
 */
export function createComposerKeymap(
  canSubmit: () => boolean,
  submit: () => void,
  now: () => number = Date.now,
) {
  let composing = false
  let composingUntil = 0

  return {
    onCompositionStart() {
      composing = true
    },
    onCompositionEnd() {
      composing = false
      // Safari can deliver the confirmation keydown after compositionend.
      composingUntil = now() + 10
    },
    onKeyDown(event: ComposerKeyEvent) {
      if (event.key !== 'Enter') return
      if (
        event.altKey ||
        event.getModifierState('AltGraph') ||
        (event.ctrlKey && event.metaKey) ||
        (event.shiftKey && (event.ctrlKey || event.metaKey))
      )
        return
      // The native plain-text editor handles Shift+Enter's line break.
      if (event.shiftKey) return
      if (
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        composing ||
        now() < composingUntil
      )
        return
      event.preventDefault()
      if (event.repeat || !canSubmit()) return
      // Worker follow-up has no busy-state queue/steer transport, so native
      // plain Enter and either supported accelerated chord share this sink.
      submit()
    },
    /** Discard composition state when the addressed Worker changes. */
    reset() {
      composing = false
      composingUntil = 0
    },
  }
}
