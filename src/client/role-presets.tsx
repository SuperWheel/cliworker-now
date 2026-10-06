import { useEffect, useRef, useState } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RolePreset } from '../shared/types.ts'
import { operationMessage } from './operation-error.ts'
import { Glyph } from './icons.tsx'
import { value, type API } from './workers.ts'

type Draft = Pick<RolePreset, 'name' | 'summary' | 'prompt'> & { id?: string }
const emptyDraft = (): Draft => ({ name: '', summary: '', prompt: '' })

/** The Host stores the library; saved workers keep their own role snapshot. */
export function RolePresetsPane({ api, sessionId }: { api: API; sessionId: string }) {
  const [presets, setPresets] = useState<RolePreset[]>([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [revision, setRevision] = useState(0)
  const action = useRef<AbortController>()
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const next: RolePreset[] = JSON.parse(
          value(await api.cliworker.rolePresets(sessionId, controller.signal)),
        )
        if (!controller.signal.aborted) setPresets(next)
      } catch (e) {
        if (!controller.signal.aborted) setError(operationMessage(e))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [api, sessionId, revision])
  useEffect(() => () => action.current?.abort(), [])

  const openEditor = (next: Draft) => {
    setDraft({ ...next })
    setConfirmDelete(false)
    setError('')
    setFeedback('')
  }
  const closeEditor = () => {
    if (busy) return
    setDraft(undefined)
    setConfirmDelete(false)
    setError('')
  }
  async function persist(remove = false) {
    if (!draft || action.current || (remove && !draft.id)) return
    const request = {
      ...draft,
      name: draft.name.trim(),
      summary: draft.summary.trim(),
      prompt: draft.prompt.trim(),
    }
    if (!remove && (!request.name || !request.summary || !request.prompt)) {
      setError('请填写智能体名称、概述和角色提示词。')
      return
    }
    const controller = new AbortController()
    action.current = controller
    setBusy(true)
    setError('')
    try {
      if (remove) {
        value(await api.cliworker.deleteRolePreset(sessionId, draft.id!, controller.signal))
        if (!controller.signal.aborted) {
          setPresets((old) => old.filter((item) => item.id !== draft.id))
          setFeedback('预设已删除，已有智能体保留原角色。')
        }
      } else {
        const saved: RolePreset = JSON.parse(
          value(await api.cliworker.saveRolePreset(sessionId, JSON.stringify(request), controller.signal)),
        )
        if (!controller.signal.aborted) {
          setPresets((old) =>
            old.some((item) => item.id === saved.id)
              ? old.map((item) => (item.id === saved.id ? saved : item))
              : [...old, saved],
          )
          setFeedback('预设已保存，可在下次派遣时选择。')
        }
      }
      if (!controller.signal.aborted) {
        setDraft(undefined)
        setConfirmDelete(false)
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(operationMessage(e))
    } finally {
      if (!controller.signal.aborted) {
        action.current = undefined
        setBusy(false)
      }
    }
  }
  const visible = presets.filter((item) =>
    `${item.name} ${item.summary}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <section className="cwn-settings-pane cwn-roles-pane" aria-label="智能体预设管理">
      <div className="cwn-roles-heading">
        <div>
          <h2>{draft ? (draft.id ? '编辑智能体' : '新增智能体') : '智能体预设'}</h2>
          <p>{draft ? '定义它的职责、方法与工作边界' : '为不同任务准备合适的协作者'}</p>
        </div>
        <span
          className="cwn-section-progress"
          role="status"
          aria-label={loading || busy ? '正在同步智能体预设' : undefined}
        >
          {(loading || busy) && <StateDot state="ongoing" size={14} />}
        </span>
      </div>
      {draft ? (
        <form
          className="cwn-role-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void persist()
          }}
        >
          <Button
            type="button"
            variant="ghost"
            size="md"
            className="cwn-role-back"
            onClick={closeEditor}
            disabled={busy}
          >
            <Glyph name="back" />
            返回预设
          </Button>
          <label>
            <span>智能体名称</span>
            <Input
              aria-label="智能体名称"
              autoFocus
              value={draft.name}
              maxLength={60}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="例如：逻辑审稿人"
            />
          </label>
          <label>
            <span>概述</span>
            <Input
              aria-label="智能体概述"
              value={draft.summary}
              maxLength={240}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
              placeholder="用一句话描述擅长的任务"
            />
          </label>
          <label>
            <span>角色提示词</span>
            <textarea
              aria-label="角色提示词"
              value={draft.prompt}
              maxLength={30000}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              placeholder="描述智能体的角色、工作方式与输出要求…"
              rows={14}
            />
          </label>
          <div className="cwn-role-editor-actions">
            {draft.id && (
              <Button
                type="button"
                variant="ghost"
                size="md"
                className="cwn-role-delete"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                删除预设
              </Button>
            )}
            <Button type="button" variant="ghost" size="md" disabled={busy} onClick={closeEditor}>
              取消
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={busy}>
              保存预设
            </Button>
          </div>
          {confirmDelete && (
            <div className="cwn-role-delete-confirm" role="alert">
              <p>删除「{draft.name}」？已有智能体仍保留原角色。</p>
              <Button
                type="button"
                variant="ghost"
                size="md"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                保留预设
              </Button>
              <Button
                type="button"
                variant="outline"
                size="md"
                className="cwn-role-delete"
                disabled={busy}
                onClick={() => void persist(true)}
              >
                确认删除
              </Button>
            </div>
          )}
        </form>
      ) : (
        <>
          <div className="cwn-roles-toolbar">
            <Input
              icon={<Glyph name="search" />}
              aria-label="搜索智能体预设"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索智能体"
            />
            <Button
              type="button"
              variant="primary"
              size="md"
              disabled={loading}
              onClick={() => openEditor(emptyDraft())}
            >
              新增预设
            </Button>
          </div>
          <div className="cwn-role-grid" aria-busy={loading}>
            {visible.map((item) => (
              <article className="cwn-role-card" key={item.id}>
                <button type="button" aria-label={`编辑预设 ${item.name}`} onClick={() => openEditor(item)}>
                  <span className="cwn-role-card-heading">
                    <strong>{item.name}</strong>
                    <Glyph name="chevron" />
                  </span>
                  <span className="cwn-role-card-summary">{item.summary}</span>
                </button>
              </article>
            ))}
          </div>
          {!loading && !error && !visible.length && (
            <p className="cwn-role-empty">
              {presets.length ? '没有匹配的预设。' : '还没有预设，添加一个智能体角色吧。'}
            </p>
          )}
          {!loading && error && (
            <Button type="button" variant="ghost" size="md" onClick={() => setRevision((n) => n + 1)}>
              重新加载预设
            </Button>
          )}
        </>
      )}
      <div className="cwn-role-feedback" role={error ? 'alert' : 'status'}>
        {error || feedback}
      </div>
    </section>
  )
}
