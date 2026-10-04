import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { active, EFFORTS, type ModelChoice, type Preference, type WorkerStatus } from '../shared/types.ts'
import { useWorkers, value, type API } from './workers.ts'

const status: Record<WorkerStatus, string> = {
  queued: '排队',
  running: '工作中',
  stopping: '正在停止',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
}
interface PanelProps {
  sessionId: string
  api: API
}
export function Panel(props: PanelProps) {
  // In-memory only: project content is never copied into browser localStorage.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  return (
    <SessionPanel
      key={props.sessionId}
      {...props}
      drafts={drafts}
      editDraft={(id, text) => setDrafts((old) => ({ ...old, [id]: text }))}
      clearSubmitted={(id, submitted) =>
        setDrafts((old) => (old[id] === submitted ? { ...old, [id]: '' } : old))
      }
    />
  )
}
function SessionPanel({
  sessionId,
  api,
  drafts,
  editDraft,
  clearSubmitted,
}: PanelProps & {
  drafts: Record<string, string>
  editDraft: (id: string, text: string) => void
  clearSubmitted: (id: string, submitted: string) => void
}) {
  const [selected, select] = useState('')
  const { snapshot, error: streamError, connecting, reconnect } = useWorkers(api, sessionId, selected)
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false)
  const error = errors[selected] ?? ''
  const setError = (text: string) => setErrors((old) => ({ ...old, [selected]: text }))
  const pendingAction = useRef(false)
  const [following, setFollowing] = useState(true)
  const alive = useRef(true),
    currentSelection = useRef(selected)
  currentSelection.current = selected
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const [catalog, setCatalog] = useState<{ models: ModelChoice[]; preference?: Preference }>()
  const [model, setModel] = useState(''),
    [effort, setEffort] = useState<Preference['effort']>('medium')
  const [settings, setSettings] = useState(false)
  const feed = useRef<HTMLDivElement>(null),
    stick = useRef(true)
  const worker = snapshot.selected
  const prompt = drafts[selected] ?? ''
  useEffect(() => {
    if (!selected && snapshot.workers[0]) select(snapshot.workers[0].id)
  }, [snapshot.workers, selected])
  useEffect(() => {
    stick.current = true
    setFollowing(true)
  }, [selected])
  useEffect(() => {
    if (stick.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }, [snapshot.timeline, selected])
  async function perform(action: (isCurrent: () => boolean) => Promise<void>) {
    if (pendingAction.current) return
    pendingAction.current = true
    const origin = selected
    const isCurrent = () => alive.current && currentSelection.current === origin
    setBusy(true)
    setError('')
    try {
      await action(isCurrent)
    } catch (e) {
      if (alive.current) setErrors((old) => ({ ...old, [origin]: String(e) }))
    } finally {
      pendingAction.current = false
      if (alive.current) setBusy(false)
    }
  }
  const running = worker && active(worker.status)
  const unavailable = connecting || !!streamError
  const canResume = worker?.conversationId && !running && !unavailable
  const jumpToLatest = () => {
    stick.current = true
    setFollowing(true)
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }
  return (
    <section className="cwn" aria-label="CLI Worker Now">
      <header className="cwn-head">
        <div>
          <span className="cwn-kicker">ANTIGRAVITY</span>
          <h2>
            CLI Worker <span>Now</span>
          </h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            void perform(async (isCurrent) => {
              if (settings) {
                setSettings(false)
                return
              }
              const data = JSON.parse(value(await api.cliworker.catalog(sessionId)))
              if (!isCurrent()) return
              setCatalog(data)
              setModel(data.preference?.model ?? data.models[0]?.id ?? '')
              setEffort(data.preference?.effort ?? 'medium')
              setSettings(true)
            })
          }
        >
          默认设置
        </Button>
      </header>
      {settings && catalog && (
        <form
          className="cwn-settings"
          onSubmit={(e) => {
            e.preventDefault()
            void perform(async (isCurrent) => {
              value(await api.cliworker.configure(sessionId, JSON.stringify({ model, effort })))
              if (isCurrent()) setSettings(false)
            })
          }}
        >
          <label>
            模型
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {catalog.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            思考强度
            <select value={effort} onChange={(e) => setEffort(e.target.value as Preference['effort'])}>
              {EFFORTS.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </label>
          <p>仅影响此项目之后新建的子 Agent，已有会话保留原配置。</p>
          <Button size="sm" variant="primary" disabled={busy || !model}>
            保存默认值
          </Button>
        </form>
      )}
      <details className="cwn-tree" open>
        <summary>
          主对话 <span>{snapshot.workers.length} 个子 Agent</span>
        </summary>
        <div role="navigation" aria-label="子 Agent">
          {snapshot.workers.map((w) => (
            <button
              key={w.id}
              className={`cwn-worker ${w.id === selected ? 'is-selected' : ''}`}
              aria-current={w.id === selected}
              onClick={() => {
                select(w.id)
              }}
            >
              <span className={`cwn-dot ${w.status}`} />
              <span className="cwn-worker-title">{w.title}</span>
              <small>{status[w.status]}</small>
            </button>
          ))}
        </div>
      </details>
      {worker && (
        <div className="cwn-meta">
          <strong>{worker.title}</strong>
          <div>
            <span>{worker.preference.model}</span>
            <span>{worker.preference.effort}</span>
            <span>{worker.mode === 'plan' ? 'CLI 规划' : '可编辑'}</span>
          </div>
        </div>
      )}
      {streamError && (
        <div role="alert" className="cwn-error">
          <div>实时连接已断开，已收到的记录保留在这里。重新连接不会重新执行任务。</div>
          <Button type="button" size="sm" variant="outline" onClick={reconnect}>
            重新连接
          </Button>
          <details>
            <summary>连接详情</summary>
            {streamError}
          </details>
        </div>
      )}
      {connecting && (
        <div className="cwn-notice" role="status">
          正在连接并恢复记录…
        </div>
      )}
      {error && (
        <div role="alert" className="cwn-error">
          {error}
        </div>
      )}
      {worker?.error && (
        <div role="status" className="cwn-error">
          {worker.error}
        </div>
      )}
      <div
        className="cwn-feed"
        ref={feed}
        onScroll={() => {
          const el = feed.current!
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          setFollowing(stick.current)
        }}
        aria-label="对话记录"
        aria-busy={running || false}
      >
        {snapshot.configuring && (
          <div className="cwn-notice">等待选择模型和思考强度。请在主对话的问题卡片中确认。</div>
        )}
        {!connecting && !streamError && !snapshot.workers.length && !snapshot.configuring && (
          <div className="cwn-empty">
            <div className="cwn-mark">↗</div>
            <h3>让协作过程看得见</h3>
            <p>在主对话中明确派遣任务：</p>
            <blockquote>用 Antigravity 帮我检查这个项目</blockquote>
            <p>首次运行先选择模型与思考强度，过程会实时显示在这里。</p>
          </div>
        )}
        {snapshot.truncated && (
          <p className="cwn-notice">
            显示最近 {snapshot.timeline.length} 条记录；完整事件保存在本机私有状态目录。
          </p>
        )}
        {snapshot.timeline.map((item) =>
          item.kind === 'tool' || item.kind === 'diagnostic' ? (
            <details className="cwn-tool" key={item.id}>
              <summary>
                <span>⌘</span> {item.text}
                <small title={item.runStatus ? `CLI 最后状态：${item.state}；未收到最终工具状态` : undefined}>
                  {item.runStatus
                    ? item.runStatus === 'interrupted'
                      ? '本轮已中断'
                      : '本轮已结束'
                    : item.state}
                </small>
              </summary>
              <pre>
                {typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail, null, 2)}
              </pre>
            </details>
          ) : item.kind === 'status' ? (
            <div className="cwn-status" key={item.id}>
              {status[item.text as WorkerStatus] ?? item.text}
            </div>
          ) : (
            <article key={item.id} className={`cwn-message ${item.kind}`}>
              <div className="cwn-message-label">
                {item.kind === 'user' ? '你' : 'Antigravity'}
                <time>
                  {new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
              <div className="cwn-text">{item.text}</div>
            </article>
          ),
        )}
      </div>
      {!following && worker && (
        <div className="cwn-jump">
          <Button type="button" size="sm" variant="outline" onClick={jumpToLatest}>
            ↓ 回到最新消息
          </Button>
        </div>
      )}
      {worker && (
        <form
          className="cwn-compose"
          onSubmit={(e) => {
            e.preventDefault()
            if (!prompt.trim() || !canResume || busy) return
            void perform(async () => {
              value(await api.cliworker.followup(sessionId, worker.id, prompt))
              clearSubmitted(worker.id, prompt)
            })
          }}
        >
          <div className="cwn-compose-state">
            <span className={`cwn-dot ${worker.status}`} />
            {status[worker.status]}
            {running && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || worker.status === 'stopping'}
                onClick={() =>
                  void perform(async () => {
                    value(await api.cliworker.stop(sessionId, worker.id))
                  })
                }
              >
                停止
              </Button>
            )}
          </div>
          {!running && !worker.conversationId && (
            <p className="cwn-resume-hint">本次运行未建立 CLI 会话，无法续聊。请在主对话重新派遣任务。</p>
          )}
          <textarea
            aria-label="继续对话"
            value={prompt}
            onChange={(e) => editDraft(worker.id, e.target.value)}
            disabled={!canResume || busy}
            maxLength={100000}
            placeholder={running ? '本轮完成后可以继续对话' : '给这个子 Agent 分配下一步…'}
            rows={2}
          />
          <div className="cwn-compose-bottom">
            <span>沿用当前模型与会话</span>
            <Button type="submit" variant="primary" size="sm" disabled={!canResume || busy || !prompt.trim()}>
              继续 ↗
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}
