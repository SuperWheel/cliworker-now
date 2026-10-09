import { useEffect, useRef, useState } from 'react'
import { Button, Menu, Tooltip, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { active, effortLabel, workerName, type Worker, type WorkerStatus } from '../shared/types.ts'
import { displayModelName } from '../shared/model-presentation.ts'
import { Glyph } from './icons.tsx'
import { NameCopy } from './name-copy.tsx'

const status: Record<WorkerStatus, string> = {
  queued: '排队中',
  running: '运行中',
  stopping: '正在停止',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
}
export type WorkerManagementAction = 'title' | 'name' | 'delete'
export function WorkerCard({
  worker,
  collapsed,
  unavailable,
  busy,
  onOpen,
  onManage,
}: {
  worker: Worker
  collapsed: boolean
  unavailable: boolean
  busy: boolean
  onOpen: () => void
  onManage: (action: WorkerManagementAction) => void
}) {
  const [menu, setMenu] = useState(false)
  const point = useRef<{ x: number; y: number }>()
  const openButton = useRef<HTMLButtonElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (collapsed) setMenu(false)
  }, [collapsed])
  const locked = collapsed || unavailable || busy
  const openMenu = (x?: number, y?: number) => {
    if (collapsed) return
    point.current = x === undefined || y === undefined ? undefined : { x, y }
    setMenu(true)
  }
  const entries: MenuEntry[] = [
    { id: 'open', label: '打开对话', disabled: collapsed },
    { id: 'title', label: '修改聊天标题', disabled: locked },
    { id: 'name', label: '修改智能体名称', disabled: locked },
    { type: 'separator', id: 'separator' },
    { id: 'delete', label: '删除', disabled: locked || active(worker.status), danger: true },
  ]
  return (
    <div
      className="cwn-worker"
      data-worker-id={worker.id}
      onClick={(event) => {
        // The native menu portal still bubbles through this React owner. Only
        // bare card/text areas open; every actual button owns its own action.
        if ((event.target as Element).closest?.('button,[role="menu"]')) return
        if (!collapsed) onOpen()
      }}
      onContextMenu={(event) => {
        if (collapsed) return
        event.preventDefault()
        event.stopPropagation()
        openMenu(event.clientX, event.clientY)
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          if (collapsed) return
          event.preventDefault()
          event.stopPropagation()
          openMenu()
        }
      }}
    >
      <button
        ref={openButton}
        type="button"
        className="cwn-worker-open"
        data-open-worker-id={worker.id}
        tabIndex={collapsed ? -1 : undefined}
        onClick={() => {
          if (!collapsed) onOpen()
        }}
      >
        <span className="cwn-worker-line">
          <span className="cwn-worker-title">{worker.title}</span>
          <span className={`cwn-worker-status ${worker.status}`}>
            <span className={`cwn-dot ${worker.status}`} />
            {status[worker.status]}
          </span>
        </span>
        <Glyph name="chevron" />
      </button>
      <div className="cwn-worker-meta">
        <NameCopy name={workerName(worker)} disabled={collapsed} />
        <span className="cwn-meta-divider" aria-hidden="true">
          ｜
        </span>
        <span className="cwn-worker-model" title={displayModelName(worker.preference)}>
          {displayModelName(worker.preference)}
        </span>
        <span className="cwn-meta-divider" aria-hidden="true">
          ·
        </span>
        <span>{effortLabel(worker.preference.effort)}</span>
        <Menu
          open={menu}
          portal
          autoFocus
          listClassName="cwn-worker-menu"
          getAnchorRect={() => {
            if (point.current) return new DOMRect(point.current.x, point.current.y, 0, 0)
            return (
              menuButton.current?.getBoundingClientRect() ??
              openButton.current?.getBoundingClientRect() ??
              null
            )
          }}
          onClose={() => setMenu(false)}
          items={entries}
          onSelect={(id) => {
            setMenu(false)
            if (id === 'open') onOpen()
            else if (id === 'title' || id === 'name' || id === 'delete') onManage(id)
          }}
          anchor={
            <Tooltip label="管理对话" side="bottom" portal>
              <Button
                ref={menuButton}
                type="button"
                variant="ghost"
                size="sm"
                className="cwn-worker-manage"
                aria-label={`管理对话 ${worker.title}`}
                tabIndex={collapsed ? -1 : undefined}
                disabled={collapsed}
                onClick={() => openMenu()}
              >
                <Glyph name="more" />
              </Button>
            </Tooltip>
          }
        />
      </div>
    </div>
  )
}
