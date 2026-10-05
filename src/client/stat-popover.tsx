import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Tooltip,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Same positioning/dismissal primitives and geometry as Harness useStatDialog. */
export function StatPopover({
  label,
  tooltip,
  context = false,
  className = '',
  trigger,
  children,
}: {
  label: string
  tooltip?: string
  context?: boolean
  className?: string
  trigger: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null),
    panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: 8,
    margin: 12,
  })
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  const button = (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      {trigger}
    </button>
  )
  return (
    <span ref={rootRef} className="cwn-stat-anchor">
      {tooltip ? (
        <Tooltip label={tooltip} side="top" delayMs={200} disabled={open} portal>
          {button}
        </Tooltip>
      ) : (
        button
      )}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            className={`cwn-stat-panel${context ? ' cwn-context-panel' : ''}`}
            style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  )
}
