import { useEffect, useRef, useState } from 'react'
import { Glyph } from './icons.tsx'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'

export function CopyText({
  text,
  label,
  iconOnly = false,
}: {
  text: string
  label: string
  iconOnly?: boolean
}) {
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const current = useRef(text),
    alive = useRef(true)
  current.current = text
  useEffect(() => {
    setFeedback('')
  }, [text])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return (
    <span className="cwn-copy">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={label}
        title={feedback || label}
        className={iconOnly ? 'cwn-copy-icon' : undefined}
        disabled={busy || !text}
        onClick={() => {
          const source = text
          setBusy(true)
          void (async () => {
            let copied = false
            try {
              copied = await writeClipboard(source)
            } catch {
              /* The visible failure state offers manual copy. */
            }
            if (!alive.current) return
            setBusy(false)
            if (current.current === source) setFeedback(copied ? '已复制' : '复制失败，请选择文本手动复制')
          })()
        }}
      >
        {iconOnly ? <Glyph name="copy" /> : feedback === '已复制' ? '已复制' : label}
      </Button>
      {feedback && (
        <span role="status" className={feedback === '已复制' ? 'cwn-sr-only' : 'cwn-copy-feedback'}>
          {feedback}
        </span>
      )}
    </span>
  )
}
