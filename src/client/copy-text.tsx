import { useEffect, useRef, useState } from 'react'
import { Glyph } from './icons.tsx'
import {
  Button,
  Tooltip,
  IconCheckOutlineRegular,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'

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
  const timer = useRef<ReturnType<typeof setTimeout>>()
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
      clearTimeout(timer.current)
    }
  }, [])
  return (
    <span className="cwn-copy">
      <Tooltip label={feedback || label} side="bottom" portal>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={label}
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
              if (current.current === source) {
                setFeedback(copied ? '已复制' : '复制失败，请选择文本手动复制')
                if (copied) {
                  clearTimeout(timer.current)
                  timer.current = setTimeout(() => setFeedback(''), 1000)
                }
              }
            })()
          }}
        >
          {iconOnly ? (
            feedback === '已复制' ? (
              <IconCheckOutlineRegular size={16} />
            ) : (
              <Glyph name="copy" />
            )
          ) : feedback === '已复制' ? (
            '已复制'
          ) : (
            label
          )}
        </Button>
      </Tooltip>
      {feedback && (
        <span role="status" className={feedback === '已复制' ? 'cwn-sr-only' : 'cwn-copy-feedback'}>
          {feedback}
        </span>
      )}
    </span>
  )
}
