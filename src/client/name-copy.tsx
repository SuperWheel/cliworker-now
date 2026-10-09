import { useEffect, useRef, useState } from 'react'
import { Tooltip, writeClipboard, IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Glyph } from './icons.tsx'

/** Independent name action: copying never activates the neighboring conversation button. */
export function NameCopy({ name, disabled = false }: { name: string; disabled?: boolean }) {
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const current = useRef(name)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  current.current = name
  useEffect(() => {
    setFeedback('')
    clearTimeout(timer.current)
  }, [name])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(timer.current)
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
          disabled={disabled || busy || !name}
          onClick={(event) => {
            event?.stopPropagation()
            const source = name
            setBusy(true)
            void (async () => {
              let copied = false
              try {
                copied = await writeClipboard(source)
              } catch {}
              if (!alive.current) return
              setBusy(false)
              if (current.current !== source) return
              clearTimeout(timer.current)
              setFeedback(copied ? '已复制' : '复制失败，请选择文本手动复制')
              if (copied) {
                timer.current = setTimeout(() => setFeedback(''), 1000)
              }
            })()
          }}
        >
          <span>{name}</span>
          {feedback === '已复制' ? <IconCheckOutlineRegular size={13} /> : <Glyph name="copy" />}
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
