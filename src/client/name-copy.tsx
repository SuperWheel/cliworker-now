import { useEffect, useRef, useState } from 'react'
import { Tooltip, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'

/** Independent name action: copying never activates the neighboring conversation button. */
export function NameCopy({ name, disabled = false }: { name: string; disabled?: boolean }) {
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const current = useRef(name)
  const hovered = useRef(false)
  const focused = useRef(false)
  const keyboard = useRef(true)
  const generation = useRef(0)
  const pending = useRef(false)
  const currentFeedback = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  current.current = name
  const clearTimer = () => {
    clearTimeout(timer.current)
    timer.current = undefined
  }
  const updateFeedback = (text: string) => {
    currentFeedback.current = text
    setFeedback(text)
  }
  const held = () => hovered.current || (keyboard.current && focused.current)
  const restoreAfterLeaving = () => {
    clearTimer()
    if (currentFeedback.current !== '已复制' || held()) return
    const source = current.current
    const request = generation.current
    timer.current = setTimeout(() => {
      timer.current = undefined
      if (alive.current && current.current === source && generation.current === request && !held())
        updateFeedback('')
    }, 1000)
  }
  useEffect(() => {
    generation.current++
    pending.current = false
    updateFeedback('')
    setBusy(false)
    clearTimer()
    if (disabled) {
      hovered.current = false
      focused.current = false
    }
  }, [name, disabled])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      generation.current++
      clearTimer()
    }
  }, [])
  return (
    <span className="cwn-name-copy">
      <Tooltip label={feedback || '点击复制名称'} side="bottom" portal>
        <button
          type="button"
          className="cwn-worker-name"
          aria-label={`复制名称 ${name}`}
          title={name}
          data-copied={feedback === '已复制'}
          disabled={disabled || !name}
          aria-busy={busy}
          onMouseEnter={() => {
            hovered.current = true
            clearTimer()
          }}
          onMouseLeave={() => {
            hovered.current = false
            restoreAfterLeaving()
          }}
          onPointerDown={() => {
            // Mouse activation leaves focus behind; only keyboard focus holds feedback.
            keyboard.current = false
          }}
          onFocus={() => {
            focused.current = true
            clearTimer()
          }}
          onBlur={() => {
            focused.current = false
            if (keyboard.current) restoreAfterLeaving()
            keyboard.current = true
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') keyboard.current = true
          }}
          onClick={(event) => {
            event?.stopPropagation()
            if (disabled || pending.current || !name) return
            if (event?.detail === 0) keyboard.current = true
            else if ((event?.detail ?? 0) > 0) keyboard.current = false
            const source = name
            const request = ++generation.current
            pending.current = true
            setBusy(true)
            clearTimer()
            void (async () => {
              let copied = false
              try {
                copied = await writeClipboard(source)
              } catch {}
              if (!alive.current || generation.current !== request || current.current !== source) return
              pending.current = false
              setBusy(false)
              updateFeedback(copied ? '已复制' : '复制失败，请选择文本手动复制')
              if (copied) restoreAfterLeaving()
            })()
          }}
        >
          <span>{feedback === '已复制' ? '已复制' : name}</span>
        </button>
      </Tooltip>
      {feedback && (
        <span role="status" className={feedback === '已复制' ? 'cwn-sr-only' : 'cwn-name-copy-failure'}>
          {feedback}
        </span>
      )}
    </span>
  )
}
