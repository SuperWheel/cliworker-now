import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Input,
  Menu,
  MenuItemButton,
  IconChevronDownOutlineRegular,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  active,
  cliOf,
  CLI_LABELS,
  effortLabel,
  type ModelChoice,
  type Preference,
  type Worker,
} from '../shared/types.ts'
import { modelName } from '../shared/models.ts'
import { value, type API } from './workers.ts'
import { operationMessage } from './operation-error.ts'

/** Native menu primitive with the same model / effort drill-in flow as Harness ModelSelect. */
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
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const [catalog, setCatalog] = useState<{ models: ModelChoice[] }>()
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
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
        if (!cancelled) setError(operationMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [open, api, sessionId, cli, attempt])
  const name = modelName(worker.preference)
  const chosen = catalog?.models.find(
    (m) => m.id === name || Object.values(m.variants ?? {}).includes(worker.preference.model),
  )
  const locked = disabled || saving || active(worker.status)
  const close = () => {
    if (!saving) {
      setOpen(false)
      setPane('root')
      setQuery('')
    }
  }
  const save = async (next: Preference) => {
    if (locked) return
    setSaving(true)
    setError('')
    try {
      value(await api.cliworker.configureWorker(sessionId, worker.id, JSON.stringify(next)))
      if (alive.current) {
        setOpen(false)
        setPane('root')
        setQuery('')
      }
    } catch (e) {
      if (alive.current) setError(operationMessage(e))
    } finally {
      if (alive.current) setSaving(false)
    }
  }
  const cell = (label: string, text: string) => (
    <span className="cwn-model-cell">
      <span>{label}</span>
      <span className="cwn-model-cell-value">{text}</span>
      <span aria-hidden="true">›</span>
    </span>
  )
  const items: MenuEntry[] =
    pane === 'root'
      ? [
          { id: 'model', label: cell('模型', name), disabled: locked },
          {
            id: 'effort',
            label: cell('思考强度', effortLabel(worker.preference.effort)),
            disabled: locked || !chosen,
          },
        ]
      : [
          { id: 'back', label: '‹ 返回', disabled: saving },
          ...(pane === 'effort'
            ? (chosen?.efforts ?? []).map((e) => ({ id: e, label: effortLabel(e), disabled: locked }))
            : []),
        ]
  return (
    <Menu
      open={open}
      portal
      align="end"
      side="top"
      className="cwn-model-menu"
      listClassName="cwn-model-popover"
      items={items}
      selectedId={pane === 'effort' ? worker.preference.effort : undefined}
      onClose={close}
      onSelect={(id) => {
        if (id === 'back') {
          setPane('root')
          return
        }
        if (pane === 'root') {
          setPane(id as 'model' | 'effort')
          return
        }
        if (pane === 'effort' && chosen?.efforts?.includes(id as Preference['effort']))
          void save({ cli, model: chosen.id, effort: id as Preference['effort'] })
      }}
      anchor={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="cwn-compose-model"
          disabled={locked}
          aria-label="模型与强度"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => (open ? close() : setOpen(true))}
          title={
            active(worker.status)
              ? '本轮结束后可以修改模型与强度'
              : `${name} · ${effortLabel(worker.preference.effort)}`
          }
        >
          <span>{name}</span>
          <span className="cwn-model-effort">{effortLabel(worker.preference.effort)}</span>
          <IconChevronDownOutlineRegular size={12} />
        </Button>
      }
    >
      {pane === 'model' && (
        <>
          <Input
            className="cwn-model-search"
            aria-label="搜索模型"
            placeholder="搜索模型"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="cwn-model-provider">{CLI_LABELS[cli]}</div>
          {catalog?.models
            .filter((m) => `${m.id} ${m.label}`.toLowerCase().includes(query.toLowerCase()))
            .map((m) => (
              <MenuItemButton
                key={m.id}
                disabled={locked}
                onSelect={() => {
                  const effort = m.efforts?.includes(worker.preference.effort)
                    ? worker.preference.effort
                    : m.efforts?.[0]
                  if (effort) void save({ cli, model: m.id, effort })
                }}
              >
                <span className="cwn-model-cell">
                  <span>{m.id}</span>
                  {m.id === chosen?.id && <span aria-hidden="true">✓</span>}
                </span>
              </MenuItemButton>
            ))}
        </>
      )}
      {!catalog && !error && (
        <div className="cwn-model-provider" role="status">
          正在读取 CLI 模型…
        </div>
      )}
      {error && (
        <div className="cwn-model-feedback" role="status">
          {error}
          <Button type="button" variant="ghost" size="sm" onClick={() => retry((n) => n + 1)}>
            重试
          </Button>
        </div>
      )}
    </Menu>
  )
}
