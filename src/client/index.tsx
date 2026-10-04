import type { Context } from '@deepseek-ai/cordis'
import { useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import remoteContribution from 'dsh-cliworker-now/remote'
import {
  active,
  EFFORTS,
  type WorkerSnapshot,
  type ModelChoice,
  type Preference,
  type WorkerStatus,
} from '../shared/types.ts'
import { styles } from './styles.ts'

const ID = 'dsh-cliworker-now'
const status: Record<WorkerStatus, string> = {
  queued: '排队',
  running: '工作中',
  stopping: '正在停止',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
}
type Snapshot = WorkerSnapshot & { configuring?: boolean }
type API = Pick<ClientRemote, '$stream' | 'cliworker'>
const value = <T,>(result: RemoteResult<T>): T => {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function useWorkers(api: API, session: string, selected = '') {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    workers: [],
    timeline: [],
    revision: 0,
    truncated: false,
  })
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setSnapshot({ workers: [], timeline: [], revision: 0, truncated: false })
    setError('')
    const stream = api.$stream<string>({
      name: `CLI Worker ${session}`,
      open: (signal) => api.cliworker.watch(session, selected, signal),
      ended: () => new Error('连接已结束，请重新打开 CLI Worker 面板'),
    })
    void (async () => {
      try {
        for await (const item of stream) {
          if (alive) {
            setSnapshot(JSON.parse(item.value))
            setError('')
          }
          item.accept()
        }
      } catch (error) {
        if (alive) setError(String(error))
      }
    })()
    return () => {
      alive = false
      void stream.dispose()
    }
  }, [api, session, selected])
  return { snapshot, error }
}
function Panel({ sessionId, api }: PropsRuntime<'sidebar.right.pane.tab'> & { api: API }) {
  const [selected, select] = useState('')
  const { snapshot, error: streamError } = useWorkers(api, sessionId, selected)
  const [prompt, setPrompt] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState<{ models: ModelChoice[]; preference?: Preference }>()
  const [model, setModel] = useState(''),
    [effort, setEffort] = useState<Preference['effort']>('medium')
  const [settings, setSettings] = useState(false)
  const feed = useRef<HTMLDivElement>(null),
    stick = useRef(true)
  const worker = snapshot.selected
  useEffect(() => {
    select('')
    setPrompt('')
    setError('')
    setCatalog(undefined)
    setSettings(false)
  }, [sessionId])
  useEffect(() => {
    if (!selected && snapshot.workers[0]) select(snapshot.workers[0].id)
  }, [snapshot.workers, selected])
  useEffect(() => {
    stick.current = true
  }, [selected])
  useEffect(() => {
    if (stick.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }, [snapshot.revision, selected])
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const running = worker && active(worker.status)
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
            void perform(async () => {
              const data = JSON.parse(value(await api.cliworker.catalog(sessionId)))
              setCatalog(data)
              setModel(data.preference?.model ?? data.models[0]?.id ?? '')
              setEffort(data.preference?.effort ?? 'medium')
              setSettings(!settings)
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
            void perform(async () => {
              value(await api.cliworker.configure(sessionId, JSON.stringify({ model, effort })))
              setSettings(false)
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
                setError('')
                setPrompt('')
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
      {(error || streamError) && (
        <div role="alert" className="cwn-error">
          {error || streamError}
        </div>
      )}
      <div
        className="cwn-feed"
        ref={feed}
        onScroll={() => {
          const el = feed.current!
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
        aria-label="对话记录"
        aria-busy={running || false}
      >
        {snapshot.configuring && (
          <div className="cwn-notice">等待选择模型和思考强度。请在主对话的问题卡片中确认。</div>
        )}
        {!snapshot.workers.length && !snapshot.configuring && (
          <div className="cwn-empty">
            <div className="cwn-mark">↗</div>
            <h3>让协作过程看得见</h3>
            <p>在主对话中明确派遣任务：</p>
            <blockquote>用 Antigravity 帮我检查这个项目</blockquote>
            <p>首次运行先选择模型与思考强度，过程会实时显示在这里。</p>
          </div>
        )}
        {snapshot.truncated && (
          <p className="cwn-notice">显示最近 1000 条记录；完整事件保存在本机私有状态目录。</p>
        )}
        {snapshot.timeline.map((item) =>
          item.kind === 'tool' || item.kind === 'diagnostic' ? (
            <details className="cwn-tool" key={item.id}>
              <summary>
                <span>⌘</span> {item.text}
                <small>{item.state}</small>
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
      {worker && (
        <form
          className="cwn-compose"
          onSubmit={(e) => {
            e.preventDefault()
            if (!prompt.trim() || running || busy) return
            void perform(async () => {
              value(await api.cliworker.followup(sessionId, worker.id, prompt))
              setPrompt('')
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
          <textarea
            aria-label="继续对话"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={running || busy}
            placeholder={running ? '本轮完成后可以继续对话' : '给这个子 Agent 分配下一步…'}
            rows={2}
          />
          <div className="cwn-compose-bottom">
            <span>沿用当前模型与会话</span>
            <Button type="submit" variant="primary" size="sm" disabled={running || busy || !prompt.trim()}>
              继续 ↗
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.remote.$mount(remoteContribution), 'cliworker:remote')
  ctx.inject(['remote.cliworker'], (scope) => {
    const remote = scope.remote,
      worker = remote.cliworker
    const api: API = { $stream: (options) => remote.$stream(options), cliworker: worker }
    scope.effect(() => {
      const style = document.createElement('style')
      style.textContent = styles
      document.head.append(style)
      return () => style.remove()
    })
    scope.effect(() =>
      scope.sidebarRightTabs.register({
        id: ID,
        kind: 'cliworker',
        title: () => 'CLI Worker',
        guide: [
          {
            id: 'cliworker',
            order: 25,
            title: () => 'CLI Worker',
            description: () => '查看 Antigravity 子 Agent 的实时工作',
            icon: () => <span>↗</span>,
          },
        ],
      }),
    )
    scope.effect(() =>
      scope.slots.inject('sidebar.right.pane.tab', () =>
        scope.slots.register({ name: 'sidebar.right.pane.tab', key: ID, inject: () => ({ api }) }, Panel),
      ),
    )
    function Header({ sessionId }: PropsRuntime<'conversation.session.header.actions'>) {
      const { snapshot } = useWorkers(api, sessionId)
      const seen = useRef(new Set<string>())
      useEffect(() => {
        seen.current.clear()
      }, [sessionId])
      const open = () => {
        if (scope.sidebarRight.mounted.getSnapshot() === sessionId) scope.sidebarRight.openTab('cliworker')
      }
      useEffect(() => {
        const ids = snapshot.workers.filter((w) => active(w.status)).map((w) => w.runId)
        if (snapshot.configuring) ids.push('configuring')
        if (ids.some((id) => !seen.current.has(id))) {
          ids.forEach((id) => seen.current.add(id))
          open()
        }
      }, [snapshot])
      const count = snapshot.workers.filter((w) => active(w.status)).length
      return (
        <Button variant="toolbar" size="sm" title="打开 CLI Worker" onClick={open}>
          ↗ CLI{count ? ` · ${count}` : ''}
        </Button>
      )
    }
    scope.effect(() =>
      scope.slots.inject('conversation.session.header.actions', () =>
        scope.slots.register({ name: 'conversation.session.header.actions', id: ID, order: 25 }, Header),
      ),
    )
  })
}
