import { ComposerTelemetry } from './telemetry.tsx'
import { ConversationTimeline } from './conversation-timeline.tsx'
import { modelName } from '../shared/models.ts'
import { operationMessage } from './operation-error.ts'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Input, Tooltip, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  active,
  CLI_IDS,
  CLI_LABELS,
  cliOf,
  effortLabel,
  type CliId,
  type WorkerStatus,
  type HistoryPage,
} from '../shared/types.ts'
import { useWorkers, value, type API } from './workers.ts'
import { CopyText } from './copy-text.tsx'
import { BrandIcon, Glyph } from './icons.tsx'
import { WorkerModelMenu } from './worker-model-menu.tsx'
import { SettingsDialog } from './settings-dialog.tsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

const status: Record<WorkerStatus, string> = {
  queued: '排队中',
  running: '运行中',
  stopping: '正在停止',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
}
interface PanelProps extends PropsRenderSlots<'settings.section'> {
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
  renderSlot,
  drafts,
  editDraft,
  clearSubmitted,
}: PanelProps & {
  drafts: Record<string, string>
  editDraft: (id: string, text: string) => void
  clearSubmitted: (id: string, submitted: string) => void
}) {
  const [selected, select] = useState('')
  const [collapsed, setCollapsed] = useState<Partial<Record<CliId, boolean>>>({})
  const overview = useRef<HTMLDivElement>(null),
    overviewScroll = useRef(0)
  const back = useRef<HTMLButtonElement>(null),
    lastWorker = useRef('')
  useLayoutEffect(() => {
    if (selected) back.current?.focus()
    else if (overview.current) {
      overview.current.scrollTop = overviewScroll.current
      overview.current
        .querySelector<HTMLButtonElement>(`[data-worker-id='${lastWorker.current}']`)
        ?.focus({ preventScroll: true })
    }
  }, [selected])
  const openWorker = (id: string) => {
    lastWorker.current = id
    setSettings(false)
    select(id)
  }
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all')
  const [historyPage, setHistoryPage] = useState<HistoryPage>()
  const history = historyPage?.workerId === selected ? historyPage : undefined
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
  const [settingsCli, setSettingsCli] = useState<CliId>('antigravity')
  const [settings, setSettings] = useState(false)
  const feed = useRef<HTMLDivElement>(null),
    stick = useRef(true)
  const worker = snapshot.selected
  const prompt = drafts[selected] ?? ''
  const composerInput = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = composerInput.current
    if (!el) return
    el.style.height = '36px'
    el.style.height = `${Math.max(36, Math.min(el.scrollHeight, 336))}px`
  }, [prompt, selected, snapshot.selected?.id])
  useEffect(() => {
    stick.current = true
    setFollowing(true)
    setHistoryPage(undefined)
  }, [selected])
  useEffect(() => {
    if (!history && stick.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }, [snapshot.timeline, selected, history])
  useEffect(() => {
    if (history && feed.current) feed.current.scrollTop = 0
  }, [history])
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
      if (alive.current) setErrors((old) => ({ ...old, [origin]: operationMessage(e) }))
    } finally {
      pendingAction.current = false
      if (alive.current) setBusy(false)
    }
  }
  const running = worker && active(worker.status)
  const unavailable = connecting || !!streamError
  const canResume = worker?.conversationId && !running && !unavailable
  const jumpToLatest = () => {
    setHistoryPage(undefined)
    stick.current = true
    setFollowing(true)
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
  }
  const visibleWorkers = snapshot.workers.filter((w) => {
    const matches =
      `${CLI_LABELS[cliOf(w.preference)]} ${w.title} ${w.preference.model} ${w.preference.effort}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    return (
      matches &&
      (filter === 'all' ||
        (filter === 'active'
          ? active(w.status)
          : filter === 'attention'
            ? w.status === 'failed' || w.status === 'interrupted'
            : w.status === 'completed'))
    )
  })
  const displayedTimeline = history?.items ?? snapshot.timeline
  const loadHistory = (direction: 'before' | 'after') => {
    const anchor = direction === 'before' ? displayedTimeline[0]?.id : displayedTimeline.at(-1)?.id
    if (!worker || !anchor) return
    void perform(async (isCurrent) => {
      const page: HistoryPage = JSON.parse(
        value(await api.cliworker.history(sessionId, worker.id, anchor, direction)),
      )
      if (!isCurrent()) return
      if (page.workerId !== worker.id) throw new Error('收到不匹配的历史记录')
      if (!page.items.length) {
        jumpToLatest()
        return
      }
      stick.current = false
      setFollowing(false)
      setHistoryPage(page)
    })
  }
  return (
    <section className="cwn" aria-label="CLI Worker Now">
      <header className="cwn-head">
        {selected ? (
          <>
            <Tooltip label="返回子 Agent 列表" side="bottom" portal>
              <Button
                ref={back}
                type="button"
                variant="outline"
                size="sm"
                className="cwn-back"
                aria-label="返回子 Agent 列表"
                onClick={() => {
                  setSettings(false)
                  select('')
                }}
              >
                <Glyph name="back" />
              </Button>
            </Tooltip>
            <h2 title={worker?.title}>
              {worker?.title ?? snapshot.workers.find((w) => w.id === selected)?.title ?? '正在加载…'}
            </h2>
            <details className="cwn-actions">
              <summary aria-label="任务选项" title="任务选项">
                <Glyph name="more" />
              </summary>
              <div className="cwn-action-menu">
                {worker && (
                  <>
                    <strong>{CLI_LABELS[cliOf(worker.preference)]}</strong>
                    <p>{worker.mode === 'plan' ? 'CLI 规划模式' : '可编辑任务'}</p>
                    {worker.observedModel && worker.observedModel !== worker.preference.model && (
                      <p>CLI 实际模型：{worker.observedModel}</p>
                    )}
                    {worker.lastResult && (
                      <CopyText
                        key={`${worker.id}:${worker.runId}`}
                        text={worker.lastResult}
                        label="复制最新结果"
                      />
                    )}
                  </>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSettingsCli(worker ? cliOf(worker.preference) : settingsCli)
                    setSettings(true)
                  }}
                >
                  默认设置
                </Button>
              </div>
            </details>
          </>
        ) : (
          <>
            <div className="cwn-wordmark">
              <BrandIcon size={36} />
              <h2 aria-label="CLI Worker Now">
                <span>cli worker</span>
                <small>NOW</small>
              </h2>
            </div>
            <Tooltip label="默认设置" side="bottom" portal>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="cwn-settings-button"
                aria-label="默认设置"
                onClick={() => setSettings(true)}
              >
                <Glyph name="settings" />
              </Button>
            </Tooltip>
          </>
        )}
      </header>
      <SettingsDialog
        renderModels={(close) => renderSlot('settings.section', { close }, { only: 'models' })}
        open={settings}
        onClose={() => setSettings(false)}
        api={api}
        sessionId={sessionId}
        initialCli={settingsCli}
      />
      {!selected && (
        <div
          className="cwn-overview"
          ref={overview}
          onScroll={() => {
            overviewScroll.current = overview.current?.scrollTop ?? 0
          }}
        >
          <Input
            className="cwn-search"
            icon={<Glyph name="search" />}
            type="search"
            aria-label="筛选子 Agent"
            placeholder="搜索话题、CLI 或模型…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="cwn-filters" role="group" aria-label="任务状态筛选">
            {(
              [
                ['all', '全部'],
                ['active', '进行中'],
                ['completed', '已完成'],
                ['attention', '异常'],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                type="button"
                variant="outline"
                size="md"
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label}
              </Button>
            ))}
          </div>
          {(query || filter !== 'all') && (
            <div className="cwn-filter-info">
              <span>{visibleWorkers.length ? `${visibleWorkers.length} 个匹配任务` : '没有匹配的任务'}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setQuery('')
                  setFilter('all')
                }}
              >
                清除筛选
              </Button>
            </div>
          )}
          <nav aria-label="子 Agent">
            {CLI_IDS.map((cli) => {
              const rows = visibleWorkers.filter((w) => cliOf(w.preference) === cli)
              if (!rows.length) return null
              return (
                <section className="cwn-cli-group" key={cli} aria-label={`${CLI_LABELS[cli]} 子 Agent`}>
                  <button
                    className="cwn-cli-heading"
                    type="button"
                    aria-expanded={!collapsed[cli]}
                    onClick={() => setCollapsed((old) => ({ ...old, [cli]: !old[cli] }))}
                  >
                    <BrandIcon cli={cli} />
                    <strong>{CLI_LABELS[cli]}</strong>
                    <span>{rows.length} 个 Agent</span>
                    <Glyph name="chevron" />
                  </button>
                  {!collapsed[cli] &&
                    rows.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        className="cwn-worker"
                        data-worker-id={w.id}
                        onClick={() => openWorker(w.id)}
                      >
                        <span className="cwn-worker-content">
                          <span className="cwn-worker-line">
                            <span className="cwn-worker-title">{w.title}</span>
                            <span className={`cwn-worker-status ${w.status}`}>
                              <span className={`cwn-dot ${w.status}`} />
                              {status[w.status]}
                            </span>
                          </span>
                          <span className="cwn-worker-meta">
                            <span title={w.preference.model}>{modelName(w.preference)}</span>
                            <span className="cwn-meta-divider" aria-hidden="true">
                              ·
                            </span>
                            <span>{effortLabel(w.preference.effort)}</span>
                          </span>
                        </span>
                        <Glyph name="chevron" />
                      </button>
                    ))}
                </section>
              )
            })}
          </nav>
          {snapshot.configuring && (
            <div className="cwn-notice">等待选择模型和思考强度。请在主对话的问题卡片中确认。</div>
          )}
          {!connecting && !streamError && !snapshot.workers.length && !snapshot.configuring && (
            <div className="cwn-empty">
              <BrandIcon size={42} />
              <h3>让协作过程看得见</h3>
              <p>在主对话中明确派遣任务：</p>
              <blockquote>用 ZCode、OMP、Pi、Harness 或 OpenCode 帮我检查这个项目</blockquote>
              <p>首次运行先选择模型与思考强度，过程会实时显示在这里。</p>
            </div>
          )}
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
          <StateDot state="ongoing" size={14} /> 正在连接并恢复记录…
        </div>
      )}
      {error && !settings && (
        <div role="alert" className="cwn-notice">
          {error}
        </div>
      )}
      {worker?.error && (
        <div role="status" className="cwn-error">
          {worker.error}
        </div>
      )}
      {selected && history && (
        <div className="cwn-history-nav" aria-label="历史翻页">
          <span>
            历史记录 {history.start + 1}–{history.end} · 读取时共 {history.total} 条
          </span>
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || unavailable || !history.hasOlder}
              onClick={() => loadHistory('before')}
            >
              更早记录
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || unavailable || !history.hasNewer}
              onClick={() => loadHistory('after')}
            >
              较新记录
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={jumpToLatest}>
              返回实时
            </Button>
          </div>
          <small>历史页保持静止，返回实时可查看最新进展。</small>
        </div>
      )}
      {selected && (
        <div
          className="cwn-feed"
          ref={feed}
          onScroll={() => {
            if (history) return
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
          {!history && snapshot.truncated && (
            <div className="cwn-history-start">
              <span>当前显示最近 {snapshot.timeline.length} 条记录</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || unavailable}
                onClick={() => loadHistory('before')}
              >
                查看更早记录
              </Button>
            </div>
          )}
          <ConversationTimeline items={displayedTimeline} worker={worker} />
        </div>
      )}
      {selected && !history && !following && worker && (
        <div className="cwn-jump">
          <Button type="button" size="sm" variant="outline" onClick={jumpToLatest}>
            ↓ 回到最新消息
          </Button>
        </div>
      )}
      {selected && worker && (
        <form
          className="cwn-compose"
          onSubmit={(e) => {
            e.preventDefault()
            if (!prompt.trim() || !canResume || busy) return
            void perform(async (isCurrent) => {
              value(await api.cliworker.followup(sessionId, worker.id, prompt))
              clearSubmitted(worker.id, prompt)
              if (isCurrent()) jumpToLatest()
            })
          }}
        >
          {!running && !worker.conversationId && (
            <p className="cwn-resume-hint">本次运行未建立 CLI 会话，无法续聊。请在主对话重新派遣任务。</p>
          )}
          <div className="cwn-compose-box">
            <textarea
              ref={composerInput}
              aria-label="继续对话"
              value={prompt}
              onChange={(e) => editDraft(worker.id, e.target.value)}
              disabled={!canResume || busy}
              maxLength={100000}
              placeholder={running ? '本轮完成后可以继续对话' : '给这个子 Agent 分配下一步…'}
              rows={1}
            />
            <div className="cwn-compose-bottom">
              <WorkerModelMenu
                key={worker.id}
                worker={worker}
                api={api}
                sessionId={sessionId}
                disabled={busy || unavailable || !!running}
              />
              {running ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="cwn-send"
                  aria-label="停止"
                  title="停止"
                  disabled={busy || worker.status === 'stopping'}
                  onClick={() =>
                    void perform(async () => {
                      value(await api.cliworker.stop(sessionId, worker.id))
                    })
                  }
                >
                  <Glyph name="stop" />
                </Button>
              ) : (
                <button
                  type="submit"
                  className="cwn-send"
                  aria-label="继续对话"
                  title="继续对话"
                  disabled={!canResume || busy || !prompt.trim()}
                >
                  <Glyph name="send" />
                </button>
              )}
            </div>
          </div>
          <ComposerTelemetry
            worker={worker}
            telemetry={snapshot.telemetry}
            statusLabel={status[worker.status]}
          />
        </form>
      )}
    </section>
  )
}
