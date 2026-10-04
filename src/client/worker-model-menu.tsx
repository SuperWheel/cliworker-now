import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Menu,
  IconChevronDownOutlineRegular,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { cliOf, effortLabel, type ModelChoice, type Preference, type Worker } from '../shared/types.ts'
import { value, type API } from './workers.ts'

/** Existing CLI conversation preferences are immutable; edits apply only to new workers. */
export function WorkerModelMenu({
  worker,
  api,
  sessionId,
  disabled,
}: {
  worker: Worker
  api: API
  sessionId: string
  disabled: boolean
}) {
  const cli = cliOf(worker.preference)
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<{ models: ModelChoice[]; preference?: Preference }>()
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError('')
    void api.cliworker
      .catalogForCli(sessionId, cli)
      .then((result) => {
        if (!cancelled) setCatalog(JSON.parse(value(result)))
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [open, api, sessionId, cli])
  const choices = new Map<string, Preference>()
  const items: MenuEntry[] = [
    { type: 'label', id: 'current-label', text: '当前会话 · 配置固定' },
    { id: 'current', label: `${worker.preference.model} · ${effortLabel(worker.preference.effort)}` },
    ...(worker.observedModel && worker.observedModel !== worker.preference.model
      ? [{ type: 'label' as const, id: 'observed', text: `CLI 实际模型：${worker.observedModel}` }]
      : []),
    { type: 'separator', id: 'divider' },
    { type: 'label', id: 'default-label', text: '新任务默认值 · 不改变当前会话' },
  ]
  for (const [mi, model] of (catalog?.models ?? []).entries()) {
    const submenu = (model.efforts ?? ['default']).map((effort, ei) => {
      const id = `default-${mi}-${ei}`
      choices.set(id, { cli: cliOf(worker.preference), model: model.id, effort })
      return { id, label: effortLabel(effort), disabled: saving }
    })
    items.push({ id: `model-${mi}`, label: model.id, submenu, disabled: saving })
  }
  if (!catalog && !error) items.push({ type: 'label', id: 'loading', text: '正在读取 CLI 模型…' })
  if (error) items.push({ type: 'label', id: 'error', text: error })
  const selectedIds = [
    'current',
    ...[...choices]
      .filter(([, p]) => p.model === catalog?.preference?.model && p.effort === catalog?.preference?.effort)
      .map(([id]) => id),
  ]
  return (
    <Menu
      open={open}
      portal
      compact
      align="end"
      side="top"
      className="cwn-model-menu"
      items={items}
      selectedIds={selectedIds}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        const next = choices.get(id)
        if (!next) {
          setOpen(false)
          return
        }
        setSaving(true)
        setError('')
        void api.cliworker
          .configure(sessionId, JSON.stringify(next))
          .then((result) => {
            value(result)
            if (alive.current) {
              setCatalog((old) => (old ? { ...old, preference: next } : old))
              setOpen(false)
            }
          })
          .catch((e) => {
            if (alive.current) setError(String(e))
          })
          .finally(() => {
            if (alive.current) setSaving(false)
          })
      }}
      anchor={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="cwn-compose-model"
          disabled={disabled || saving}
          aria-label="模型与强度"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={`当前会话：${worker.preference.model} · ${effortLabel(worker.preference.effort)}`}
        >
          <span>{worker.preference.model}</span>
          <span className="cwn-model-effort">{effortLabel(worker.preference.effort)}</span>
          <IconChevronDownOutlineRegular size={12} />
        </Button>
      }
    />
  )
}
